import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  checkPublishedRequestLimit,
  ensurePublishedUsageTable,
  MAX_PUBLISHED_BUNDLE_BYTES,
  PUBLISHED_REQUEST_DAILY_LIMIT,
  publishedBundleSizeBytes,
} from '../src/space/published-limits'
import { saveDeploymentBundle, type BranchDeploymentBundle } from '../src/space/deploy-engine'

function uniqueStub() {
  const id = env.FsHarnessDO.idFromName(`published-usage-${Date.now()}-${Math.random()}`)
  return env.FsHarnessDO.get(id)
}

describe('published app resource limits', () => {
  it('persists a daily request quota and rolls the bucket at UTC midnight', async () => {
    const stub = uniqueStub()
    await runInDurableObject(stub, async (_instance, state) => {
      ensurePublishedUsageTable(state.storage.sql)
      const dayOne = new Date('2026-10-21T12:00:00.000Z')
      expect(checkPublishedRequestLimit(state.storage.sql, dayOne, 2).allowed).toBe(true)
      expect(checkPublishedRequestLimit(state.storage.sql, dayOne, 2).allowed).toBe(true)
      expect(checkPublishedRequestLimit(state.storage.sql, dayOne, 2).allowed).toBe(false)

      const nextDay = new Date('2026-10-22T00:00:00.000Z')
      const nextDayResult = checkPublishedRequestLimit(state.storage.sql, nextDay, 2)
      expect(nextDayResult.allowed).toBe(true)
      expect(nextDayResult.requestCount).toBe(1)
      expect(nextDayResult.retryAfterSeconds).toBe(86_400)
    })
  })

  it('defines a per-app daily cap and enforces the published bundle-size ceiling', () => {
    const bundle = {
      modules: { 'index.js': 'export default {}' },
      assets: { '/index.html': '<h1>hello</h1>' },
    } as BranchDeploymentBundle

    expect(PUBLISHED_REQUEST_DAILY_LIMIT).toBe(10_000)
    expect(publishedBundleSizeBytes(bundle)).toBeGreaterThan(0)
    expect(
      publishedBundleSizeBytes({
        ...bundle,
        assets: { '/large.txt': 'x'.repeat(MAX_PUBLISHED_BUNDLE_BYTES) },
      }),
    ).toBeGreaterThan(MAX_PUBLISHED_BUNDLE_BYTES)
  })

  it('stores a published snapshot separately from preview branch deployments', async () => {
    const stub = uniqueStub()
    const deployment = (branch: string, commitHash: string): BranchDeploymentBundle => ({
      branch,
      commitHash,
      mainModule: 'index.js',
      modules: { 'index.js': `// ${commitHash}` },
      assets: {},
      assetConfig: undefined,
      compatibilityDate: '2025-04-01',
    })

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE deployments (
          branch TEXT PRIMARY KEY,
          commit_hash TEXT NOT NULL,
          main_module TEXT NOT NULL,
          modules TEXT NOT NULL,
          assets TEXT NOT NULL DEFAULT '{}',
          asset_config TEXT NOT NULL DEFAULT '{}',
          deployed_at INTEGER NOT NULL
        )
      `)
      saveDeploymentBundle(state.storage.sql, deployment('main', 'preview-1'))
      saveDeploymentBundle(state.storage.sql, deployment('main', 'published-1'), '__masidy_published__')

      const rows = state.storage.sql
        .exec('SELECT branch, commit_hash FROM deployments ORDER BY branch')
        .toArray() as { branch: string; commit_hash: string }[]
      expect(rows).toEqual([
        { branch: '__masidy_published__', commit_hash: 'published-1' },
        { branch: 'main', commit_hash: 'preview-1' },
      ])
    })
  })
})
