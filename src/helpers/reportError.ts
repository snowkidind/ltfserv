/**
 * Fire-and-forget error reporter — POSTs caught errors to webserv for DB logging.
 * Call this from any catch block you want visibility on.
 *
 *   reportError('runModel/15m', err)
 *   reportError('fetchBinanceCandles', err)
 */
const WEBSERV_URL = process.env.WEBSERV_URL ?? 'http://localhost:3000'
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? ''

export function reportError(location: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err))
  fetch(`${WEBSERV_URL}/internal/errors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': INTERNAL_API_KEY,
    },
    body: JSON.stringify({
      service: 'ltfserv',
      location,
      message: e.message,
      stack: e.stack ?? null,
    }),
  }).catch(() => {}) // never let this throw
}
