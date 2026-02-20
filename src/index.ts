/**
 * ltfserv — Multi-Timeframe SS Model Runner
 *
 * Dual-mode operation:
 *   Paper mode: subscribes to dataserv socket, handles mtf_candles events from paperserv
 *   Live mode:  clock-driven boundary detection + Binance REST for candle data
 *
 * On each MTF boundary:
 *   1. Run SS model with candle array
 *   2. POST full envelope to oracle (awaited — oracle writes ss_model_runs, responds { runId })
 *   3. Broadcast WS with oracle's runId
 *
 * Startup catch-up: reads last-run boundaries from runtime-lastrun.json (written after
 * each successful oracle delivery). DB is no longer used by ltfserv.
 */
import 'dotenv/config'
import http from 'node:http'
import express from 'express'

import settings, { loadLastRuns, saveLastRun } from './config/appSettings.js'
import { logger } from './helpers/logger.js'
import { registerProcess, deregisterProcess } from './db/processRegistry.js'
import { executeRunner, buildRunnerInput } from './engine/modelRunner.js'
import { LiveScheduler } from './engine/scheduler.js'
import { UnixSocketClient } from './servers/unixSocketClient.js'
import { attachWsServer, broadcast, getClientCount, closeWsServer } from './servers/wsServer.js'
import { createRouter } from './servers/restApi.js'
import { reportError } from './helpers/reportError.js'
import type { MtfTimeframe, Candle, RunSource, MtfModelConfig, RunnerOutput } from './types/index.js'

// ── State ─────────────────────────────────────────────────────

let mode: 'paper' | 'live' = 'live'
const lastRun: Record<string, number | null> = { '15m': null, '4h': null, '1d': null, '7d': null }

const scheduler = new LiveScheduler()
const upstream = new UnixSocketClient()

// ── Binance REST (live mode candle source) ─────────────────────

const BINANCE_INTERVAL: Record<MtfTimeframe, string> = {
  '15m': '15m',
  '4h':  '4h',
  '1d':  '1d',
  '7d':  '1w',   // Binance uses '1w' for weekly candles (Mon 00:00 UTC boundaries)
}

const TF_MS: Record<MtfTimeframe, number> = {
  '15m': 15 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
}

async function fetchBinanceCandles(tf: MtfTimeframe, limit: number): Promise<Candle[]> {
  const symbol = 'BTCUSDT'
  const interval = BINANCE_INTERVAL[tf]
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance API error: ${res.status} ${res.statusText}`)

  const data = await res.json() as Array<Array<string | number>>
  return data.map(k => ({
    timestamp: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    buyVolume: 0,
    sellVolume: 0,
    cvd: 0,
    tradeCount: Number(k[8]),
    sources: ['LIVE:BTCUSDT'],
  }))
}

// ── Oracle POST ────────────────────────────────────────────────

/**
 * POST the full run envelope to oracle and await its DB row id.
 * Oracle is now the sole writer of ss_model_runs.
 * Returns the oracle-assigned DB row id, or null on failure.
 */
async function postToOracle(
  tf: MtfTimeframe,
  boundaryTs: number,
  source: RunSource,
  config: MtfModelConfig,
  candles: Candle[],
  output: RunnerOutput,
): Promise<number | null> {
  const args = {
    source:          config.source,
    maType:          config.maType,
    slowLength:      config.slowLength,
    fastLength:      config.fastLength,
    signalSmoothing: config.signalSmoothing,
  }

  const payload = {
    timeframe:  tf,
    boundaryTs,
    modelDate:  candles[candles.length - 1]?.timestamp ?? boundaryTs,
    runId:      output.runId,    // runner's own ID
    source,
    formula:    config.formula,
    args,
    output,
  }

  try {
    const res = await fetch(`${settings.oracleUrl}/ltf/run`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Internal-Key': settings.internalApiKey,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      logger.error(`Oracle POST failed for ${tf}: HTTP ${res.status}`)
      return null
    }

    const body = await res.json() as { ok: boolean; runId: number | null }
    logger.info(`Oracle POST OK for ${tf} — runId=${body.runId}`)
    return body.runId ?? null
  } catch (err) {
    logger.error(`Oracle POST error for ${tf}:`, err)
    return null
  }
}

// ── Core run logic ────────────────────────────────────────────

async function runModel(
  tf: MtfTimeframe,
  boundaryTs: number,
  candles: Candle[],
  source: RunSource,
): Promise<void> {
  if (candles.length === 0) {
    logger.warn(`runModel: no candles for ${tf} at ${new Date(boundaryTs).toISOString()}`)
    return
  }

  const config = settings.mtfConfigs[tf]
  logger.info(`Running ${tf} model (${source}): ${candles.length} candles, formula=${config.formula}`)

  try {
    const input = buildRunnerInput(candles, config)
    const { output, durationMs } = await executeRunner(input)

    // Attach raw signal prices so the frontend can display actual BTC prices
    output.prices = input.signal

    lastRun[tf] = boundaryTs

    // POST to oracle (awaited — oracle writes to ss_model_runs and returns runId)
    const runId = await postToOracle(tf, boundaryTs, source, config, candles, output)
    if (runId === null) {
      reportError(`runModel/${tf}`, new Error('Oracle POST failed — watchdog will handle missed boundary'))
      // Do NOT persist lastRun — oracle didn't acknowledge; watchdog will re-trigger
    } else {
      // Oracle confirmed receipt — safe to persist boundary as completed
      saveLastRun(tf, boundaryTs)
    }

    // Broadcast to WS clients with oracle's DB row id (null if oracle was unreachable)
    broadcast({ type: 'ltf_run', timeframe: tf, boundaryTs, source, runId, output })

    logger.info(`${tf} run complete: runId=${runId}, duration=${durationMs}ms`)
  } catch (err) {
    logger.error(`runModel failed for ${tf}`, err)
    reportError(`runModel/${tf}`, err)
  }
}

// ── Mode switching ─────────────────────────────────────────────

function enablePaperMode(): void {
  if (mode === 'paper') return
  mode = 'paper'
  scheduler.stop()
  logger.info('Switched to paper mode')
  broadcast({ type: 'mode', mode: 'paper' })
}

function enableLiveMode(): void {
  if (mode === 'live') return
  mode = 'live'
  // Re-init scheduler from saved last-run state
  initLiveScheduler().catch(err => logger.error('Failed to reinit live scheduler', err))
  logger.info('Switched to live mode')
  broadcast({ type: 'mode', mode: 'live' })
}

// ── Live mode startup & catch-up ───────────────────────────────

async function initLiveScheduler(): Promise<void> {
  const tfs: MtfTimeframe[] = ['15m', '4h', '1d']
  const saved = loadLastRuns()
  const initial: Partial<Record<MtfTimeframe, number>> = {}

  for (const tf of tfs) {
    if (saved[tf] != null) {
      initial[tf] = saved[tf]!
      lastRun[tf] = saved[tf]!
    }
  }

  scheduler.start(initial)
}

// ── Wire upstream socket events ────────────────────────────────

upstream.on('paperOn', enablePaperMode)
upstream.on('paperOff', enableLiveMode)

upstream.on('paper_loop', async () => {
  logger.info('Paper loop reset detected — purging paper runs via oracle')
  try {
    await fetch(`${settings.oracleUrl}/paper/purge-ltf`, {
      method: 'POST',
      headers: { 'X-Internal-Key': settings.internalApiKey },
    })
    logger.info('Paper purge via oracle OK')
  } catch (err) {
    reportError('paper_loop/purge', err)
  }
})

upstream.on('mtf_candles', async (event: {
  timeframe: MtfTimeframe
  boundaryTimestamp: number
  candles: Candle[]
}) => {
  if (mode !== 'paper') return
  await runModel(event.timeframe, event.boundaryTimestamp, event.candles, 'paper')
})

upstream.on('disconnected', () => {
  broadcast({ type: 'upstream_disconnected' })
})

// ── Wire live scheduler events ─────────────────────────────────

scheduler.on('trigger', async (tf: MtfTimeframe, boundaryTs: number) => {
  if (mode !== 'live') return

  try {
    const candles = await fetchBinanceCandles(tf, 176)
    await runModel(tf, boundaryTs, candles, 'live')
  } catch (err) {
    logger.error(`Live scheduler trigger failed for ${tf}`, err)
    reportError(`liveScheduler/${tf}`, err)
  }
})

// ── HTTP server ────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.use('/', createRouter({
  getMode: () => mode,
  getLastRun: () => ({ ...lastRun }),
  isUpstreamConnected: () => upstream.isConnected(),
  triggerRun: async (tf: MtfTimeframe) => {
    const ms = TF_MS[tf]
    const boundaryTs = Math.floor(Date.now() / ms) * ms
    const candles = await fetchBinanceCandles(tf, 176)
    await runModel(tf, boundaryTs, candles, 'live')
  },
}))

const httpServer = http.createServer(app)
attachWsServer(httpServer)

// ── Startup ────────────────────────────────────────────────────

async function start(): Promise<void> {
  logger.info('=== ltfserv starting ===')

  // Start HTTP + WS server
  await new Promise<void>(resolve => {
    httpServer.listen(settings.httpPort, () => {
      logger.info(`HTTP + WS server listening on :${settings.httpPort}`)
      resolve()
    })
  })

  // Register process
  registerProcess()

  // Connect to dataserv socket for paper mode events
  upstream.connect()

  // Start live scheduler with catch-up from runtime-lastrun.json
  await initLiveScheduler()

  logger.info('=== ltfserv ready ===')

  if (typeof process.send === 'function') process.send('ready')
}

// ── Graceful shutdown ──────────────────────────────────────────

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`${signal} received, shutting down...`)

  deregisterProcess()
  scheduler.stop()
  upstream.close()
  closeWsServer()
  httpServer.close()

  logger.info('ltfserv shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start().catch(err => {
  logger.error('ltfserv failed to start', err)
  process.exit(1)
})
