/**
 * WebSocket server — broadcasts run envelopes and status to connected clients.
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { logger } from '../helpers/logger.js'

let wss: WebSocketServer | null = null

export function attachWsServer(httpServer: Server): void {
  wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    logger.info(`WS client connected (total: ${wss!.clients.size})`)
    ws.on('close', () => logger.debug(`WS client disconnected (total: ${wss!.clients.size})`))
    ws.on('error', (err) => logger.warn(`WS client error: ${err.message}`))
  })

  logger.info('WebSocket server attached')
}

export function broadcast(msg: Record<string, unknown>): void {
  if (!wss) return

  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data) } catch { /* handled by close */ }
    }
  }
}

export function getClientCount(): number {
  return wss?.clients.size ?? 0
}

export function closeWsServer(): void {
  wss?.close()
  wss = null
}
