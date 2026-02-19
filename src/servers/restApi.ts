/**
 * ltfserv REST API
 * Proxied by webserv at /v1/ltf/* (path rewritten: /ltf/history → /history)
 */
import express from 'express'
import settings, { saveConfigs } from '../config/appSettings.js'
import { logger } from '../helpers/logger.js'
import { getRuns, getRunById } from '../db/runHistory.js'
import type { MtfTimeframe, RunSource } from '../types/index.js'

const VALID_TIMEFRAMES: MtfTimeframe[] = ['15m', '4h', '1d']
const VALID_SOURCES: RunSource[] = ['live', 'paper']

interface StatusProvider {
  getMode: () => 'paper' | 'live'
  getLastRun: () => Record<string, number | null>
  isUpstreamConnected: () => boolean
}

export function createRouter(statusProvider: StatusProvider): express.Router {
  const router = express.Router()

  // ── Health ────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ltfserv', pid: process.pid })
  })

  // ── Status ────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    res.json({
      mode: statusProvider.getMode(),
      lastRun: statusProvider.getLastRun(),
      upstreamConnected: statusProvider.isUpstreamConnected(),
    })
  })

  // ── Config ────────────────────────────────────────────────────

  router.get('/config', (_req, res) => {
    res.json({
      timeframes: VALID_TIMEFRAMES,
      configs: settings.mtfConfigs,
      runnerPath: settings.runnerPath,
      oracleUrl: settings.oracleUrl,
    })
  })

  router.patch('/config', async (req, res) => {
    const body = req.body as {
      timeframe?: string
      formula?: string
      source?: string
      maType?: string
      slowLength?: number
      fastLength?: number
      signalSmoothing?: number
    }

    if (!body.timeframe || !VALID_TIMEFRAMES.includes(body.timeframe as MtfTimeframe)) {
      res.status(400).json({ error: `timeframe must be one of: ${VALID_TIMEFRAMES.join(', ')}` })
      return
    }

    const tf = body.timeframe as MtfTimeframe
    const cfg = settings.mtfConfigs[tf]

    if (body.formula !== undefined) cfg.formula = String(body.formula)
    if (body.source !== undefined) {
      const validSources = ['open', 'high', 'low', 'close']
      if (!validSources.includes(body.source)) {
        res.status(400).json({ error: `source must be one of: ${validSources.join(', ')}` })
        return
      }
      cfg.source = body.source as 'open' | 'high' | 'low' | 'close'
    }
    if (body.maType !== undefined) {
      if (!['ema', 'ma'].includes(body.maType)) {
        res.status(400).json({ error: 'maType must be ema or ma' })
        return
      }
      cfg.maType = body.maType as 'ema' | 'ma'
    }
    if (body.slowLength !== undefined) cfg.slowLength = Number(body.slowLength)
    if (body.fastLength !== undefined) cfg.fastLength = Number(body.fastLength)
    if (body.signalSmoothing !== undefined) cfg.signalSmoothing = Number(body.signalSmoothing)

    logger.info(`Config updated for ${tf}: ${JSON.stringify(cfg)}`)

    // Persist all configs to runtime-config.json so they survive restarts
    try {
      saveConfigs(settings.mtfConfigs)
    } catch (err) {
      logger.warn('Failed to persist MTF configs to file:', (err as Error).message)
    }

    res.json({ ok: true, timeframe: tf, config: cfg })
  })

  // ── History ───────────────────────────────────────────────────

  router.get('/history', async (req, res) => {
    const timeframe = req.query.timeframe as MtfTimeframe | undefined
    const source = req.query.source as RunSource | undefined
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200)
    const before = req.query.before ? parseInt(String(req.query.before), 10) : undefined

    if (timeframe && !VALID_TIMEFRAMES.includes(timeframe)) {
      res.status(400).json({ error: `timeframe must be one of: ${VALID_TIMEFRAMES.join(', ')}` })
      return
    }
    if (source && !VALID_SOURCES.includes(source)) {
      res.status(400).json({ error: `source must be one of: ${VALID_SOURCES.join(', ')}` })
      return
    }

    try {
      const result = await getRuns(timeframe, limit, before, source)
      res.json(result)
    } catch (err) {
      logger.error('GET /history failed', err)
      res.status(500).json({ error: 'Failed to fetch run history' })
    }
  })

  router.get('/history/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }

    try {
      const run = await getRunById(id)
      if (!run) {
        res.status(404).json({ error: 'Run not found' })
        return
      }
      res.json(run)
    } catch (err) {
      logger.error(`GET /history/${id} failed`, err)
      res.status(500).json({ error: 'Failed to fetch run' })
    }
  })

  return router
}
