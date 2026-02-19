/**
 * Model runner — spawns the Snowsignals Rust binary as a subprocess,
 * feeds it candle data via stdin JSON, reads output from stdout.
 * Ported from snowserv/src/engine/modelRunner.ts.
 */
import { spawn } from 'node:child_process'
import { logger } from '../helpers/logger.js'
import settings from '../config/appSettings.js'
import type { RunnerInput, RunnerOutput, MtfModelConfig, Candle } from '../types/index.js'

const RUNNER_TIMEOUT = 30_000 // 30s — MTF runs process more candles than 10s snowserv

export interface RunResult {
  output: RunnerOutput
  durationMs: number
}

/**
 * Execute the runner binary with the given input payload.
 * Returns the parsed RunnerOutput on success, or throws on failure.
 */
export function executeRunner(input: RunnerInput): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    const child = spawn(settings.runnerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SNOWSIGNALS_CONFIG_DIR: settings.configDir,
      },
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`Runner timed out after ${RUNNER_TIMEOUT}ms`))
    }, RUNNER_TIMEOUT)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      const durationMs = Date.now() - startTime

      if (code !== 0) {
        const msg = `Runner exited with code ${code}: ${stderr.trim()}`
        logger.error(msg)
        reject(new Error(msg))
        return
      }

      try {
        const output: RunnerOutput = JSON.parse(stdout.trim())
        logger.debug(`Runner completed in ${durationMs}ms (runId=${output.runId})`)
        resolve({ output, durationMs })
      } catch (err) {
        reject(new Error(`Failed to parse runner output: ${(err as Error).message}`))
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Failed to spawn runner: ${err.message}`))
    })

    const payload = JSON.stringify(input) + '\n'
    child.stdin.write(payload)
    child.stdin.end()
  })
}

/**
 * Build RunnerInput from candles and per-timeframe config.
 * Extracts the configured price source (open/high/low/close) as the signal.
 */
export function buildRunnerInput(candles: Candle[], config: MtfModelConfig): RunnerInput {
  const signal = candles.map(c => c[config.source])

  return {
    formula: config.formula,
    signal,
    options: {
      ma_type: config.maType,
      slow_length: config.slowLength,
      fast_length: config.fastLength,
      signal_smoothing: config.signalSmoothing,
    },
    trace: config.trace,
  }
}
