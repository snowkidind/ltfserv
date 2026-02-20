import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MtfModelConfig, MtfTimeframe } from '../types/index.js'

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const OVERRIDES_PATH  = resolve(__dirname, '../../runtime-config.json')
const LAST_RUN_PATH   = resolve(__dirname, '../../runtime-lastrun.json')

export function saveConfigs(configs: Record<MtfTimeframe, MtfModelConfig>): void {
  writeFileSync(OVERRIDES_PATH, JSON.stringify(configs, null, 2) + '\n')
}

function loadConfigOverrides(): Partial<Record<MtfTimeframe, MtfModelConfig>> {
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

/** Load last-run timestamps from runtime-lastrun.json (replaces DB query). */
export function loadLastRuns(): Partial<Record<MtfTimeframe, number>> {
  try {
    return JSON.parse(readFileSync(LAST_RUN_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

/** Persist a successful run boundary so initLiveScheduler can catch up after restart. */
export function saveLastRun(tf: MtfTimeframe, boundaryTs: number): void {
  const current = loadLastRuns()
  current[tf] = boundaryTs
  try {
    writeFileSync(LAST_RUN_PATH, JSON.stringify(current, null, 2) + '\n')
  } catch (err) {
    // Non-fatal — scheduler will just start from scratch for this TF on next restart
    console.warn('[ltfserv] Failed to persist runtime-lastrun.json:', (err as Error).message)
  }
}

const _overrides = loadConfigOverrides()

/** Per-timeframe model configurations — swappable at runtime via REST, persisted to runtime-config.json */
export const MTF_CONFIGS: Record<MtfTimeframe, MtfModelConfig> = {
  '15m': {
    formula: env('FORMULA_15M', '4h_SLOW_MOON'),
    source: 'close',
    maType: 'ema',
    slowLength: 26,
    fastLength: 12,
    signalSmoothing: 0,
    trace: false,
    ...(_overrides['15m'] ?? {}),
  },
  '4h': {
    formula: env('FORMULA_4H', '4h_SLOW_MOON'),
    source: 'close',
    maType: 'ema',
    slowLength: 26,
    fastLength: 12,
    signalSmoothing: 0,
    trace: false,
    ...(_overrides['4h'] ?? {}),
  },
  '1d': {
    formula: env('FORMULA_1D', '4h_SLOW_MOON'),
    source: 'close',
    maType: 'ema',
    slowLength: 26,
    fastLength: 12,
    signalSmoothing: 0,
    trace: false,
    ...(_overrides['1d'] ?? {}),
  },
  '7d': {
    formula: env('FORMULA_7D', '4h_SLOW_MOON'),
    source: 'close',
    maType: 'ema',
    slowLength: 26,
    fastLength: 12,
    signalSmoothing: 0,
    trace: false,
    ...(_overrides['7d'] ?? {}),
  },
}

const settings = {
  httpPort: parseInt(env('HTTP_PORT', '3006'), 10),
  dataservSocketPath: env('DATASERV_SOCKET_PATH', '/tmp/dataserv.sock'),
  logLevel: env('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',

  /** Absolute path to snowsignals runner binary */
  runnerPath: env('RUNNER_PATH', '/Users/kenyMobile/Desktop/ssModel/model/target/release/runner'),

  /** Base directory for snowsignals config */
  configDir: env('SNOWSIGNALS_CONFIG_DIR', '/Users/kenyMobile/Desktop/ssModel/model/config'),

  /** Oracle service URL for posting run envelopes (direct internal port, not webserv proxy) */
  oracleUrl: env('ORACLE_URL', 'http://localhost:3003'),

  /** Shared internal API key — required for /paper/purge-ltf */
  internalApiKey: env('INTERNAL_API_KEY', ''),

  /** MTF model configs — mutable at runtime */
  mtfConfigs: MTF_CONFIGS,
}

export default settings
