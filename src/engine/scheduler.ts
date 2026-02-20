/**
 * Live-mode scheduler — detects MTF timeframe boundary crossings using wall-clock time.
 * Fires 'trigger' events when a new boundary is entered for each tracked timeframe.
 */
import { EventEmitter } from 'node:events'
import { logger } from '../helpers/logger.js'
import type { MtfTimeframe } from '../types/index.js'

const TF_MS: Record<MtfTimeframe, number> = {
  '15m': 15 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
}

const MTF_TIMEFRAMES: MtfTimeframe[] = ['15m', '4h', '1d', '7d']

export class LiveScheduler extends EventEmitter {
  private lastFired = new Map<MtfTimeframe, number>()
  private checkTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Start clock-driven checking every 10 seconds.
   * Initializes lastFired from DB on startup (caller provides initial state).
   */
  start(initialLastRun: Partial<Record<MtfTimeframe, number>>): void {
    for (const [tf, ts] of Object.entries(initialLastRun) as [MtfTimeframe, number][]) {
      this.lastFired.set(tf, ts)
    }

    this.checkTimer = setInterval(() => this.check(), 10_000)
    // Also check immediately on start
    this.check()
    logger.info('LiveScheduler started')
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    logger.info('LiveScheduler stopped')
  }

  private check(): void {
    const now = Date.now()
    for (const tf of MTF_TIMEFRAMES) {
      const ms = TF_MS[tf]
      const boundary = Math.floor(now / ms) * ms
      if (boundary > (this.lastFired.get(tf) ?? 0)) {
        this.lastFired.set(tf, boundary)
        logger.info(`LiveScheduler: ${tf} boundary at ${new Date(boundary).toISOString()}`)
        this.emit('trigger', tf, boundary)
      }
    }
  }

  /**
   * Mark a timeframe as having fired at the given boundary.
   * Called after a successful run to prevent re-firing.
   */
  markFired(tf: MtfTimeframe, boundaryTs: number): void {
    this.lastFired.set(tf, boundaryTs)
  }
}
