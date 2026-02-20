/** Candle — matches dataserv Candle interface */
export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  buyVolume: number
  sellVolume: number
  cvd: number
  tradeCount: number
  sources: string[]
}

/** Socket messages from dataserv (superset) */
export interface DataservMessage {
  type: string
  timestamp?: number
  candles?: Candle[]
  timeframe?: string
  boundaryTimestamp?: number
  [key: string]: unknown
}

/** Supported MTF timeframes */
export type MtfTimeframe = '15m' | '4h' | '1d' | '7d'

/** Run source type */
export type RunSource = 'live' | 'paper'

/** Per-timeframe model configuration */
export interface MtfModelConfig {
  formula: string
  source: 'open' | 'high' | 'low' | 'close'
  maType: 'ema' | 'ma'
  slowLength: number
  fastLength: number
  signalSmoothing: number
  trace: boolean
}

/** Runner input (stdin JSON) */
export interface RunnerInput {
  formula: string
  signal: number[]
  options: {
    ma_type: 'ema' | 'ma'
    slow_length: number
    fast_length: number
    signal_smoothing: number
  }
  trace?: boolean
}

/** Indicator fired by the runner */
export interface IndicatorFired {
  i: number
  weight: number
  type: 'buy' | 'sell' | 'hold' | 'none'
  label?: string
  decay?: number
}

/** Single histogram bar from runner output */
export interface HistogramBar {
  signal: number
  slowY: number | null
  fastY: number | null
  maDiff: number | null
  attitude: 'rising' | 'falling' | null
  channel: 'up' | 'down' | null
  isAT: boolean
  isCT: boolean
  indicatorsFired: IndicatorFired[]
  barsAgo: number
  [key: string]: unknown
}

/** Runner output (stdout JSON) */
export interface RunnerOutput {
  runId: number
  screen_x: number
  screen_y: number
  px_per_bar: number
  signalSmoothing: number
  candles: number[]
  slow: (number | null)[]
  fast: (number | null)[]
  prices?: number[]        // raw input signal prices — attached after runner execution
  histogram: HistogramBar[]
  crossover: { candles_since_crossover: number; crossover_slow_angle_degrees: number } | null
  slow_angle: { slow_angle_degrees: number }
  indicatorsFired: number[]
  formulae: { selected: string; b: number[]; s: number[]; h: number[] }
  analysis: Record<string, unknown>
}

/** Saved run record from DB */
export interface SnowRun {
  id: number
  timeframe: MtfTimeframe
  boundaryTs: number
  source: RunSource
  formula: string
  args: {
    source: string
    maType: string
    slowLength: number
    fastLength: number
    signalSmoothing: number
  }
  output: RunnerOutput
  createdAt: number
}
