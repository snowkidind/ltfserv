import settings from '../config/appSettings.js'

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const
const currentLevel = levels[settings.logLevel] ?? levels.info

function ts(): string {
  return new Date().toISOString()
}

export const logger = {
  debug(msg: string) {
    if (currentLevel <= levels.debug) console.log(`[${ts()}] [DEBUG] [ltfserv] ${msg}`)
  },
  info(msg: string) {
    if (currentLevel <= levels.info) console.log(`[${ts()}] [INFO] [ltfserv] ${msg}`)
  },
  warn(msg: string) {
    if (currentLevel <= levels.warn) console.warn(`[${ts()}] [WARN] [ltfserv] ${msg}`)
  },
  error(msg: string, err?: unknown) {
    if (currentLevel <= levels.error) {
      console.error(`[${ts()}] [ERROR] [ltfserv] ${msg}`)
      if (err) console.error(err)
    }
  },
}
