import { describe, expect, it } from 'vitest'
import { connectionStringIssue, endpointOf } from '@/lib/connection-string.ts'

/**
 * The cases here are not invented: every one of them was pasted into a real
 * .env.local and produced a message that named neither the variable nor the
 * character at fault. `Invalid URL` for three of them, and for one — a `@` in
 * the password — no error at all, just a connection to the wrong host.
 */
const GOOD =
  'postgresql://postgres.abcdefgh:s3cret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'

describe('connectionStringIssue', () => {
  it('accepts a well-formed connection string', () => {
    expect(connectionStringIssue(GOOD)).toBeNull()
    expect(connectionStringIssue(`  ${GOOD}  `)).toBeNull()
    expect(connectionStringIssue(GOOD.replace('postgresql://', 'postgres://'))).toBeNull()
  })

  it('names the reserved character when the password holds one', () => {
    for (const [char, encoded] of [
      ['#', '%23'],
      ['/', '%2F'],
      ['?', '%3F'],
    ] as const) {
      const issue = connectionStringIssue(GOOD.replace('s3cret', `s3c${char}ret`))
      expect(issue?.problem).toContain(char)
      expect(issue?.fix).toContain(encoded)
    }
  })

  it('does not mistake the host for a password problem', () => {
    // The `@` separating userinfo from host is the LAST one, so an encoded `@`
    // inside the password must not shift what counts as the host.
    expect(connectionStringIssue(GOOD.replace('s3cret', 's3c%40ret'))).toBeNull()
  })

  it('catches the shapes that come from copying rather than typing', () => {
    expect(connectionStringIssue(`"${GOOD}"`)?.problem).toContain('guillemets')
    expect(connectionStringIssue(`psql ${GOOD}`)?.problem).toContain('psql')
    expect(connectionStringIssue(GOOD.replace('s3cret', '[YOUR-PASSWORD]'))?.problem).toContain(
      'YOUR-PASSWORD',
    )
  })

  it('rejects prose, which the driver would silently accept', () => {
    // pg-connection-string reads the word "base" in a French sentence as a
    // hostname and fails much later with `getaddrinfo ENOTFOUND base`.
    for (const value of ['Votre base Supabase', 'authentification', 'la base de données']) {
      expect(connectionStringIssue(value)?.problem).toContain("n'est pas une chaîne de connexion")
    }
  })

  it('describes the shape of a rejected value without revealing it', () => {
    // Enough to tell a line never replaced from one saved in the wrong file,
    // and not one character of the value itself.
    const issue = connectionStringIssue('Votre base Supabase')
    expect(issue?.problem).toContain('19 caractères')
    expect(issue?.problem).toContain('sans « :// »')
    expect(issue?.problem).toContain('2 espaces')
    expect(issue?.problem).not.toContain('Supabase Votre')
    expect(issue?.problem).not.toContain('base')
  })

  it('names a wrong scheme rather than describing it', () => {
    expect(connectionStringIssue('mysql://user:pw@host:3306/db')?.problem).toContain('mysql://')
    expect(
      connectionStringIssue(`jdbc:${GOOD}`)?.problem,
    ).toContain('JDBC')
  })

  it('reports an absent variable as absent, not as malformed', () => {
    expect(connectionStringIssue(undefined)?.problem).toContain("n'est pas définie")
    expect(connectionStringIssue('   ')?.problem).toContain("n'est pas définie")
  })

  it('exposes host and port, and never the password', () => {
    expect(endpointOf(GOOD)).toBe('aws-0-eu-central-1.pooler.supabase.com:5432')
    expect(endpointOf(GOOD)).not.toContain('s3cret')
    expect(endpointOf(GOOD.replace(':5432', ''))).toContain(':5432')
    expect(endpointOf('pas une url')).toBe('illisible')
    expect(endpointOf(undefined)).toBe('non défini')
  })
})
