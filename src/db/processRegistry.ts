/**
 * Process registry — broadcasts registration over ltfserv's own WS server.
 */
import { broadcast } from '../servers/wsServer.js'
import { logger } from '../helpers/logger.js'
import settings from '../config/appSettings.js'

export function registerProcess(): void {
  broadcast({
    type: 'processRegister',
    appType: 'ltfserv',
    pid: process.pid,
    metadata: { port: settings.httpPort, pid: process.pid },
  })
  logger.info(`Broadcast processRegister (pid=${process.pid})`)
}

export function deregisterProcess(): void {
  broadcast({ type: 'processDeregister', appType: 'ltfserv' })
  logger.info('Broadcast processDeregister')
}
