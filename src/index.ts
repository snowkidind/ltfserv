/**
 * ltfserv — Multi-Timeframe SS Model Runner
 *
 * Dual-mode operation:
 *   Paper mode: subscribes to dataserv socket, handles mtf_candles events from paperserv
 *   Live mode:  clock-driven boundary detection + Binance REST for candle data
 *
 * On each MTF boundary:
 *   1. Run SS model with candle array
 *   2. Save result to ss_model_runs (cursor DB)
 *   3. POST envelope to oracle (fire-and-forget)
 *
 * Startup catch-up: reads MAX(boundary_ts) per timeframe from DB and runs
 * any missed intervals since last restart.
 */
import 'dotenv/config'
import http from 'node:http'
import express from 'express'

import settings from './config/appSettings.js'
import { logger } from './helpers/logger.js'
import { closePool } from './db/pool.js'
import { insertRun, deletePaperRuns, getLastRunTs } from './db/runHistory.js'
import { registerProcess, deregisterProcess } from './db/processRegistry.js'
import { executeRunner, buildRunnerInput } from './engine/modelRunner.js'
import { LiveScheduler } from './engine/scheduler.js'
import { UnixSocketClient } from './servers/unixSocketClient.js'
import { attachWsServer, broadcast, getClientCount, closeWsServer } from './servers/wsServer.js'
import { createRouter } from './servers/restApi.js'
import { reportError } from './helpers/reportError.js'
import type { MtfTimeframe, Candle, RunSource } from './types/index.js'

// ── State ─────────────────────────────────────────────────────

let mode: 'paper' | 'live' = 'live'
const lastRun: Record<string, number | null> = { '15m': null, '4h': null, '1d': null }

const scheduler = new LiveScheduler()
const upstream = new UnixSocketClient()

// ── Binance REST (live mode candle source) ─────────────────────

const BINANCE_INTERVAL: Record<MtfTimeframe, string> = {
  '15m': '15m',
  '4h':  '4h',
  '1d':  '1d',
}

const TF_MS: Record<MtfTimeframe, number> = {
  '15m': 15 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
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

async function postToOracle(tf: string, boundaryTs: number, runId: number | null, output: unknown): Promise<void> {
  try {
    await fetch(`${settings.oracleUrl}/api/ltf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeframe: tf, boundaryTs, runId, output }),
    })
    logger.info(`Oracle POST OK for ${tf}`)
  } catch (err) {
    logger.error(`Oracle POST failed for ${tf}`, err)
    // Continue — run was already saved to DB
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
    // (runner output uses normalized screen coordinates; signal has real prices)
    output.prices = input.signal

    lastRun[tf] = boundaryTs

    // Save to DB (fire and forget oracle, but wait for DB)
    const runId = await insertRun(tf, boundaryTs, source, config, output)

    // Broadcast to WS clients
    broadcast({ type: 'ltf_run', timeframe: tf, boundaryTs, source, runId, output })

    // POST to oracle (fire-and-forget)
    postToOracle(tf, boundaryTs, runId, output).catch(() => {})

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
  // Re-read last runs from DB and restart scheduler
  initLiveScheduler().catch(err => logger.error('Failed to reinit live scheduler', err))
  logger.info('Switched to live mode')
  broadcast({ type: 'mode', mode: 'live' })
}

// ── Live mode startup & catch-up ───────────────────────────────

async function initLiveScheduler(): Promise<void> {
  const tfs: MtfTimeframe[] = ['15m', '4h', '1d']
  const initial: Partial<Record<MtfTimeframe, number>> = {}

  for (const tf of tfs) {
    const last = await getLastRunTs(tf, 'live')
    if (last !== null) {
      initial[tf] = last
      lastRun[tf] = last
    }
  }

  scheduler.start(initial)
}

// ── Wire upstream socket events ────────────────────────────────

upstream.on('paperOn', enablePaperMode)
upstream.on('paperOff', enableLiveMode)

upstream.on('paper_loop', async () => {
  logger.info('Paper loop reset detected — purging paper runs')
  await deletePaperRuns()
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

  // Start live scheduler with catch-up
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
  await closePool()

  logger.info('ltfserv shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start().catch(err => {
  logger.error('ltfserv failed to start', err)
  closePool().then(() => process.exit(1))
})
