/**
 * PostgreSQL connection pool for the cursor DB (webserv DB).
 * Stores ss_model_runs and other application data.
 */
import pg from 'pg'
import { logger } from '../helpers/logger.js'

const { Pool } = pg

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  options: '-c timezone=UTC',
})

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', err)
})

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params)
}

export async function closePool() {
  logger.info('Closing DB pool...')
  await pool.end()
  logger.info('DB pool closed')
}
