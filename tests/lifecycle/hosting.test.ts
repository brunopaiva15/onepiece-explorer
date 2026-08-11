import { afterEach, describe, expect, it } from 'vitest'
import { isVercelRuntime, vercelFlagLooksPulled } from '@/lib/hosting.ts'

/**
 * `vercel env pull` writes VERCEL="1" into the file it produces, so following
 * the documented way to fetch your configuration leaves a laptop claiming to be
 * a deployment. Three behaviours change on that flag, and the upload ceiling is
 * the one that matters: 4.5 MB is the platform's request limit, and escaping it
 * is the entire reason importing happens locally.
 */
const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
})

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('isVercelRuntime', () => {
  it('is true only on a production build that also claims Vercel', () => {
    setEnv({ VERCEL: '1', NODE_ENV: 'production' })
    expect(isVercelRuntime()).toBe(true)
    expect(vercelFlagLooksPulled()).toBe(false)
  })

  it('is false for a pulled flag on a development server', () => {
    setEnv({ VERCEL: '1', NODE_ENV: 'development' })
    expect(isVercelRuntime()).toBe(false)
    expect(vercelFlagLooksPulled()).toBe(true)
  })

  it('is false when nothing claims Vercel at all', () => {
    setEnv({ VERCEL: undefined, NODE_ENV: 'production' })
    expect(isVercelRuntime()).toBe(false)
    expect(vercelFlagLooksPulled()).toBe(false)
  })
})

describe('the upload ceiling follows it', () => {
  it('keeps the configured ceiling locally and takes the host one on Vercel', async () => {
    const { uploadTransportLimitBytes, transportLimitIsHostImposed } = await import(
      '@/domains/ingestion/limits.ts'
    )

    setEnv({ VERCEL: '1', NODE_ENV: 'development', MAX_UPLOAD_BYTES: '524288000' })
    expect(uploadTransportLimitBytes()).toBe(524_288_000)
    expect(transportLimitIsHostImposed()).toBe(false)

    setEnv({ VERCEL: '1', NODE_ENV: 'production' })
    expect(uploadTransportLimitBytes()).toBe(4 * 1_024 * 1_024)
    expect(transportLimitIsHostImposed()).toBe(true)
  })
})
