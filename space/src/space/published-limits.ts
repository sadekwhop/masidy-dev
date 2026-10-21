import type { BranchDeploymentBundle } from './deploy-engine'

export const PUBLISHED_REQUEST_DAILY_LIMIT = 10_000
export const MAX_PUBLISHED_BUNDLE_BYTES = 5 * 1024 * 1024

export function ensurePublishedUsageTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS published_request_usage (
      utc_day TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL
    )
  `)
}

export function checkPublishedRequestLimit(
  sql: SqlStorage,
  now: Date = new Date(),
  limit: number = PUBLISHED_REQUEST_DAILY_LIMIT,
): { allowed: boolean; retryAfterSeconds: number; requestCount: number } {
  const utcDay = now.toISOString().slice(0, 10)
  const rows = sql.exec(
    `INSERT INTO published_request_usage (utc_day, request_count)
     VALUES (?, 1)
     ON CONFLICT(utc_day) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
    utcDay,
  ).toArray() as { request_count: number }[]
  const requestCount = rows[0]?.request_count ?? limit + 1
  const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return {
    allowed: requestCount <= limit,
    retryAfterSeconds: Math.ceil((nextUtcDay - now.getTime()) / 1000),
    requestCount,
  }
}

export function publishedBundleSizeBytes(bundle: BranchDeploymentBundle): number {
  return new TextEncoder().encode(
    JSON.stringify({ modules: bundle.modules, assets: bundle.assets }),
  ).byteLength
}
