/**
 * ss_model_runs table operations.
 *
 * Retention policy (pruned on every INSERT):
 *   15m → 7 days
 *   4h  → 30 days
 *   1d  → 90 days
 *
 * source column: 'live' for clock-driven runs, 'paper' for paper-mode replay.
 * Unique index on (timeframe, boundary_ts, source) prevents duplicates within
 * one loop pass while still allowing live+paper for the same boundary.
 */
import { query } from './pool.js'
import { logger } from '../helpers/logger.js'
import type { MtfTimeframe, RunnerOutput, MtfModelConfig, RunSource, SnowRun } from '../types/index.js'

const RETENTION: Record<MtfTimeframe, string> = {
  '15m': '7 days',
  '4h':  '30 days',
  '1d':  '90 days',
}

export async function insertRun(
  timeframe: MtfTimeframe,
  boundaryTs: number,
  source: RunSource,
  config: MtfModelConfig,
  output: RunnerOutput,
): Promise<number | null> {
  const args = {
    source: config.source,
    maType: config.maType,
    slowLength: config.slowLength,
    fastLength: config.fastLength,
    signalSmoothing: config.signalSmoothing,
  }

  try {
    const res = await query(
      `INSERT INTO ss_model_runs (timeframe, boundary_ts, source, formula, args, output)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (timeframe, boundary_ts, source) DO UPDATE
         SET formula = EXCLUDED.formula,
             args    = EXCLUDED.args,
             output  = EXCLUDED.output,
             created_at = NOW()
       RETURNING id`,
      [
        timeframe,
        new Date(boundaryTs).toISOString(),
        source,
        config.formula,
        JSON.stringify(args),
        JSON.stringify(output),
      ]
    )

    const id: number = res.rows[0].id

    // Prune old live rows for this timeframe (paper runs are managed by deletePaperRuns)
    await query(
      `DELETE FROM ss_model_runs
       WHERE timeframe = $1 AND source = 'live' AND boundary_ts < NOW() - INTERVAL '${RETENTION[timeframe]}'`,
      [timeframe]
    )

    return id
  } catch (err) {
    logger.error(`insertRun failed for ${timeframe} at ${new Date(boundaryTs).toISOString()}`, err)
    return null
  }
}

/**
 * Delete all paper-mode runs. Called at the start of each paper loop so
 * subsequent boundary triggers produce fresh rows without UNIQUE conflicts.
 */
export async function deletePaperRuns(): Promise<void> {
  try {
    const res = await query(`DELETE FROM ss_model_runs WHERE source = 'paper'`)
    logger.info(`deletePaperRuns: removed ${res.rowCount} paper runs`)
  } catch (err) {
    logger.error('deletePaperRuns failed', err)
  }
}

/** Get the most recent boundary_ts for a timeframe (used for startup catch-up). */
export async function getLastRunTs(timeframe: MtfTimeframe, source: RunSource = 'live'): Promise<number | null> {
  try {
    const res = await query(
      `SELECT EXTRACT(EPOCH FROM boundary_ts) * 1000 AS ts
       FROM ss_model_runs
       WHERE timeframe = $1 AND source = $2
       ORDER BY boundary_ts DESC LIMIT 1`,
      [timeframe, source]
    )
    if (res.rows.length === 0) return null
    return Number(res.rows[0].ts)
  } catch (err) {
    logger.error(`getLastRunTs failed for ${timeframe}`, err)
    return null
  }
}

/** Get paginated run history for a timeframe. */
export async function getRuns(
  timeframe: MtfTimeframe | undefined,
  limit: number,
  before: number | undefined,
  source: RunSource | undefined,
): Promise<{ runs: SnowRun[]; hasMore: boolean }> {
  try {
    const conditions: string[] = []
    const params: unknown[] = []
    let paramIdx = 1

    if (timeframe) {
      conditions.push(`timeframe = $${paramIdx++}`)
      params.push(timeframe)
    }
    if (source) {
      conditions.push(`source = $${paramIdx++}`)
      params.push(source)
    }
    if (before !== undefined) {
      conditions.push(`id < $${paramIdx++}`)
      params.push(before)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const fetchLimit = limit + 1 // fetch one extra to detect hasMore

    params.push(fetchLimit)
    const res = await query(
      `SELECT id, timeframe, boundary_ts, source, formula, args, output, created_at
       FROM ss_model_runs
       ${where}
       ORDER BY id DESC
       LIMIT $${paramIdx}`,
      params
    )

    const hasMore = res.rows.length > limit
    const rows = hasMore ? res.rows.slice(0, limit) : res.rows

    const runs: SnowRun[] = rows.map(r => ({
      id: r.id,
      timeframe: r.timeframe as MtfTimeframe,
      boundaryTs: new Date(r.boundary_ts).getTime(),
      source: r.source as RunSource,
      formula: r.formula,
      args: r.args,
      output: r.output,
      createdAt: new Date(r.created_at).getTime(),
    }))

    return { runs, hasMore }
  } catch (err) {
    logger.error('getRuns failed', err)
    return { runs: [], hasMore: false }
  }
}

/** Get a single run by ID. */
export async function getRunById(id: number): Promise<SnowRun | null> {
  try {
    const res = await query(
      `SELECT id, timeframe, boundary_ts, source, formula, args, output, created_at
       FROM ss_model_runs WHERE id = $1`,
      [id]
    )
    if (res.rows.length === 0) return null
    const r = res.rows[0]
    return {
      id: r.id,
      timeframe: r.timeframe as MtfTimeframe,
      boundaryTs: new Date(r.boundary_ts).getTime(),
      source: r.source as RunSource,
      formula: r.formula,
      args: r.args,
      output: r.output,
      createdAt: new Date(r.created_at).getTime(),
    }
  } catch (err) {
    logger.error(`getRunById failed for id=${id}`, err)
    return null
  }
}
