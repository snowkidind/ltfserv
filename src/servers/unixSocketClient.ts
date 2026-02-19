/**
 * Unix socket client — subscribes to dataserv socket to receive
 * mtf_candles events (paper mode) and mode-change signals.
 *
 * Ported and extended from snowserv/src/servers/unixSocketClient.ts.
 */
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { logger } from '../helpers/logger.js'
import settings from '../config/appSettings.js'
import type { DataservMessage, Candle, MtfTimeframe } from '../types/index.js'

export class UnixSocketClient extends EventEmitter {
  private socket: net.Socket | null = null
  private partial = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false

  connect(): void {
    if (this.socket) return

    logger.info(`Connecting to dataserv socket: ${settings.dataservSocketPath}`)
    this.socket = net.createConnection(settings.dataservSocketPath)

    this.socket.on('connect', () => {
      this.connected = true
      this.partial = ''
      logger.info('Connected to dataserv socket')
      this.emit('connected')
    })

    this.socket.on('data', (chunk: Buffer) => {
      this.partial += chunk.toString()
      this.drain()
    })

    this.socket.on('close', () => {
      this.connected = false
      this.socket = null
      logger.warn('Dataserv socket closed, reconnecting in 2s...')
      this.emit('disconnected')
      this.scheduleReconnect()
    })

    this.socket.on('error', (err) => {
      logger.error('Dataserv socket error', err)
      this.socket?.destroy()
      this.socket = null
      this.connected = false
      this.scheduleReconnect()
    })
  }

  private drain(): void {
    const parts = this.partial.split('\n\n')
    this.partial = parts.pop() ?? ''

    for (const raw of parts) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      try {
        const msg: DataservMessage = JSON.parse(trimmed)
        this.handleMessage(msg)
      } catch (err) {
        logger.warn(`Failed to parse socket message: ${(err as Error).message}`)
      }
    }
  }

  private handleMessage(msg: DataservMessage): void {
    switch (msg.type) {
      case 'mtf_candles':
        if (msg.timeframe && msg.boundaryTimestamp !== undefined && Array.isArray(msg.candles)) {
          this.emit('mtf_candles', {
            timeframe: msg.timeframe as MtfTimeframe,
            boundaryTimestamp: msg.boundaryTimestamp as number,
            candles: msg.candles as Candle[],
          })
        }
        break

      case 'paper_loop':
        // paperserv started a new loop — signal to purge paper runs
        this.emit('paper_loop')
        break

      case 'paperOn':
        logger.info('Paper mode enabled — switching to paper mode')
        this.emit('paperOn')
        break

      case 'paperOff':
        logger.info('Paper mode disabled — switching to live mode')
        this.emit('paperOff')
        break

      case 'startup':
        logger.info('Dataserv startup signal received')
        this.emit('upstream_startup')
        break

      case 'shutdown':
        logger.info('Dataserv shutdown signal received')
        this.emit('upstream_shutdown')
        break

      default:
        logger.debug(`Unhandled socket message type: ${msg.type}`)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }

  isConnected(): boolean {
    return this.connected
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.destroy()
    this.socket = null
    this.connected = false
  }
}
