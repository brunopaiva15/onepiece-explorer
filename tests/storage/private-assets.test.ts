import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertSafeKey,
  keyOwner,
  storageKey,
} from '@/domains/storage/adapter.ts'
import {
  LocalFsStorage,
  signKey,
  verifySignature,
} from '@/domains/storage/local-storage.ts'

/**
 * Private assets must not be reachable without both ownership and a valid,
 * unexpired signature. "Les assets privés ne sont jamais publiquement
 * accessibles" is an acceptance criterion, so it gets tests rather than a
 * comment.
 */

let root: string
let store: LocalFsStorage
const SECRET = 'test-signing-secret'

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ope-storage-'))
  store = new LocalFsStorage({ root, secret: SECRET, defaultTtl: 60 })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('storage keys', () => {
  it('scopes a key by user so a listing cannot mix two libraries', () => {
    const key = storageKey({
      userId: 'user-a',
      chapterId: 'chap-1',
      kind: 'original',
      filename: 'page-01.webp',
    })
    expect(key).toBe('user-a/chap-1/original/page-01.webp')
    expect(keyOwner(key)).toBe('user-a')
  })

  it('sanitises a hostile filename rather than trusting it', () => {
    const key = storageKey({
      userId: 'user-a',
      chapterId: 'chap-1',
      kind: 'original',
      filename: '../../../etc/passwd',
    })
    expect(key).not.toContain('..')
    expect(() => assertSafeKey(key)).not.toThrow()
  })

  it.each([
    ['traversal', 'user-a/../user-b/secret.webp'],
    ['absolute', '/etc/passwd'],
    ['backslash', 'user-a\\..\\user-b'],
    ['null byte', 'user-a/page\0.webp'],
    ['double slash', 'user-a//page.webp'],
    ['empty', ''],
  ])('rejects a %s key', (_label, key) => {
    expect(() => assertSafeKey(key)).toThrow()
  })
})

describe('local storage driver', () => {
  it('round-trips a file', async () => {
    const key = 'user-a/chap-1/original/page-01.webp'
    await store.put(key, Buffer.from('page bytes'), 'image/webp')
    expect(await store.exists(key)).toBe(true)
    expect(Buffer.from(await store.get(key)).toString()).toBe('page bytes')
  })

  it('refuses to read outside its root even if the file exists', async () => {
    const outside = path.join(root, '..', 'ope-outside-secret.txt')
    await writeFile(outside, 'secret')
    try {
      await expect(store.get('../ope-outside-secret.txt')).rejects.toThrow()
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('refuses a key that escapes via a nested path', async () => {
    await mkdir(path.join(root, 'user-a'), { recursive: true })
    await expect(store.get('user-a/../../escape.txt')).rejects.toThrow()
  })
})

describe('signed URLs', () => {
  const key = 'user-a/chap-1/original/page-01.webp'

  it('produces a relative URL carrying an expiry and a signature', async () => {
    const url = await store.signedUrl(key, 60)
    expect(url.startsWith('/api/assets/')).toBe(true)
    const params = new URL(url, 'http://localhost').searchParams
    expect(Number(params.get('exp'))).toBeGreaterThan(Date.now() / 1000)
    expect(params.get('sig')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts its own signature', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    expect(verifySignature(SECRET, key, exp, signKey(SECRET, key, exp))).toBe(true)
  })

  it('rejects an expired link — a leaked URL must stop working', () => {
    const exp = Math.floor(Date.now() / 1000) - 1
    expect(verifySignature(SECRET, key, exp, signKey(SECRET, key, exp))).toBe(false)
  })

  it('rejects a signature minted for a different key', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const other = signKey(SECRET, 'user-b/chap-1/original/page-01.webp', exp)
    expect(verifySignature(SECRET, key, exp, other)).toBe(false)
  })

  it('rejects a signature minted with a different secret', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    expect(
      verifySignature(SECRET, key, exp, signKey('other-secret', key, exp)),
    ).toBe(false)
  })

  it('rejects a tampered expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const sig = signKey(SECRET, key, exp)
    expect(verifySignature(SECRET, key, exp + 86_400, sig)).toBe(false)
  })

  it('rejects a malformed signature without throwing', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    expect(verifySignature(SECRET, key, exp, '')).toBe(false)
    expect(verifySignature(SECRET, key, exp, 'nope')).toBe(false)
    expect(verifySignature(SECRET, key, Number.NaN, 'x'.repeat(64))).toBe(false)
  })
})
