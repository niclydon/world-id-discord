import { verificationResultItemSchema } from '@/schemas/verification-result-item'
import { CredentialType } from '@/types/credential-type'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getIntegrationApiStore, VerificationResultConflictError } from './store'

// Run with DISCORD_POSTGRES_TEST_URL set to a disposable PostgreSQL 16/17 database.
// The adapter runs the actual PostgresStore queries over PostgreSQL's wire protocol. It does not test
// the hosted Neon HTTP transport or its database connection configuration.
const postgresUrl = process.env.DISCORD_POSTGRES_TEST_URL
const databaseTests = postgresUrl ? describe : describe.skip
const harness = vi.hoisted(() => ({
  makeClient: null as
    null | (() => { query: (statement: string, params?: unknown[]) => Promise<unknown> }),
}))

vi.mock('@neondatabase/serverless', () => ({
  neon: () => {
    if (!harness.makeClient) throw new Error('Postgres test client is not configured')
    return harness.makeClient()
  },
}))

const globalStore = globalThis as typeof globalThis & {
  integrationApiStore?: ReturnType<typeof getIntegrationApiStore>
}

const owner = {
  guild_id: 'guild-1',
  nullifier_hash: '0xabc123',
  signal_type: CredentialType.Orb,
  user_id: 'user-1',
  environment: 'production' as const,
}

const twoArrivalGate = () => {
  let arrivals = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  return {
    wait: async () => {
      arrivals += 1
      if (arrivals === 2) release()
      await gate
    },
    arrivals: () => arrivals,
  }
}

databaseTests('Postgres integration store SQL', () => {
  let admin: Pool
  let schema: string
  let clients: Pool[]
  let beforeSchemaInit: (() => Promise<void>) | null
  let beforeVerificationInsert: (() => Promise<void>) | null

  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl })
    await admin.query('SELECT 1')
  })

  afterAll(async () => {
    await admin?.end()
  })

  beforeEach(async () => {
    schema = `discord_store_test_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE SCHEMA ${schema}`)
    clients = []
    beforeSchemaInit = null
    beforeVerificationInsert = null
    harness.makeClient = () => {
      // Each PostgresStore gets its own pool and therefore an independent
      // database connection for the ownership race.
      const pool = new Pool({
        connectionString: postgresUrl,
        options: `-c search_path=${schema}`,
      })
      clients.push(pool)
      return {
        query: async (statement, params) => {
          if (beforeSchemaInit && statement.startsWith('DO $$')) {
            await beforeSchemaInit()
          }
          if (
            beforeVerificationInsert &&
            statement.startsWith('INSERT INTO integration_api_verification_results')
          ) {
            await beforeVerificationInsert()
          }
          return (await pool.query(statement, params)).rows
        },
      }
    }
    vi.stubEnv('INTEGRATION_API_DATABASE_URL', 'postgresql://unused.invalid/test')
    delete globalStore.integrationApiStore
  })

  afterEach(async () => {
    harness.makeClient = null
    beforeSchemaInit = null
    beforeVerificationInsert = null
    delete globalStore.integrationApiStore
    vi.unstubAllEnvs()
    await Promise.all((clients ?? []).map(client => client.end()))
    if (schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  it('initializes both tables in an empty database', async () => {
    const store = getIntegrationApiStore()

    await expect(store.getBotConfig('missing')).resolves.toBeNull()
    await expect(
      store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    ).resolves.toBeNull()
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    )
    expect(tables.rows.map(row => row.table_name)).toEqual([
      'integration_api_bot_configs',
      'integration_api_verification_results',
    ])
  })

  it('serializes two cold starts against the same empty schema', async () => {
    const first = getIntegrationApiStore()
    delete globalStore.integrationApiStore
    const second = getIntegrationApiStore()
    const gate = twoArrivalGate()
    beforeSchemaInit = gate.wait

    await expect(
      Promise.all([first.getBotConfig('missing'), second.getBotConfig('missing')])
    ).resolves.toEqual([null, null])
    expect(gate.arrivals()).toBe(2)
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    )
    expect(tables.rows.map(row => row.table_name)).toEqual([
      'integration_api_bot_configs',
      'integration_api_verification_results',
    ])
    expect(clients).toHaveLength(2)
  })

  it('adds environment to a legacy table but leaves its owner untrusted', async () => {
    await admin.query(
      `CREATE TABLE ${schema}.integration_api_verification_results (
        guild_id text NOT NULL,
        nullifier_hash text NOT NULL,
        signal_type text NOT NULL,
        user_id text NOT NULL,
        PRIMARY KEY (guild_id, nullifier_hash)
      )`
    )
    await admin.query(
      `INSERT INTO ${schema}.integration_api_verification_results
        (guild_id, nullifier_hash, signal_type, user_id)
       VALUES ($1, $2, $3, $4)`,
      [owner.guild_id, owner.nullifier_hash, owner.signal_type, owner.user_id]
    )

    const store = getIntegrationApiStore()
    const legacy = await store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    expect(legacy).toMatchObject({ ...owner, environment: null })
    expect(verificationResultItemSchema.safeParse(legacy).success).toBe(false)
    await expect(store.saveVerificationResult(owner)).rejects.toBeInstanceOf(
      VerificationResultConflictError
    )
    const saved = await admin.query<{ environment: string | null }>(
      `SELECT environment FROM ${schema}.integration_api_verification_results
       WHERE guild_id = $1 AND nullifier_hash = $2`,
      [owner.guild_id, owner.nullifier_hash]
    )
    expect(saved.rows).toEqual([{ environment: null }])
  })

  it('serializes two cold starts upgrading the same legacy table and row', async () => {
    await admin.query(
      `CREATE TABLE ${schema}.integration_api_verification_results (
        guild_id text NOT NULL,
        nullifier_hash text NOT NULL,
        signal_type text NOT NULL,
        user_id text NOT NULL,
        PRIMARY KEY (guild_id, nullifier_hash)
      )`
    )
    await admin.query(
      `INSERT INTO ${schema}.integration_api_verification_results
        (guild_id, nullifier_hash, signal_type, user_id)
       VALUES ($1, $2, $3, $4)`,
      [owner.guild_id, owner.nullifier_hash, owner.signal_type, owner.user_id]
    )

    const first = getIntegrationApiStore()
    delete globalStore.integrationApiStore
    const second = getIntegrationApiStore()
    const gate = twoArrivalGate()
    beforeSchemaInit = gate.wait
    const rows = await Promise.all([
      first.getVerificationResult(owner.guild_id, owner.nullifier_hash),
      second.getVerificationResult(owner.guild_id, owner.nullifier_hash),
    ])
    expect(gate.arrivals()).toBe(2)
    expect(rows).toEqual([
      { ...owner, environment: null },
      { ...owner, environment: null },
    ])
    expect(rows.every(row => !verificationResultItemSchema.safeParse(row).success)).toBe(true)
    await expect(second.saveVerificationResult(owner)).rejects.toBeInstanceOf(
      VerificationResultConflictError
    )
    const saved = await admin.query<{ environment: string | null }>(
      `SELECT environment FROM ${schema}.integration_api_verification_results
       WHERE guild_id = $1 AND nullifier_hash = $2`,
      [owner.guild_id, owner.nullifier_hash]
    )
    expect(saved.rows).toEqual([{ environment: null }])
    expect(clients).toHaveLength(2)
  })

  it('accepts an exact retry and refuses a different user, signal, or environment', async () => {
    const store = getIntegrationApiStore()

    await store.saveVerificationResult(owner)
    await expect(store.saveVerificationResult(owner)).resolves.toBeUndefined()
    for (const changed of [
      { ...owner, user_id: 'user-2' },
      { ...owner, signal_type: CredentialType.Device },
      { ...owner, environment: 'sandbox' as const },
    ]) {
      await expect(store.saveVerificationResult(changed)).rejects.toBeInstanceOf(
        VerificationResultConflictError
      )
    }
    await expect(
      store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    ).resolves.toEqual(owner)
    const count = await admin.query<{ count: string }>(
      `SELECT count(*) FROM ${schema}.integration_api_verification_results`
    )
    expect(count.rows[0].count).toBe('1')
  })

  it('gives one of two independent stores the nullifier in a simultaneous race', async () => {
    const first = getIntegrationApiStore()
    delete globalStore.integrationApiStore
    const second = getIntegrationApiStore()
    expect(first).not.toBe(second)

    // Finish initialization before the barrier so both calls reach the same
    // INSERT rather than racing table creation.
    await Promise.all([first.getBotConfig('missing'), second.getBotConfig('missing')])
    expect(clients).toHaveLength(2)
    const backends = await Promise.all(
      clients.map(client => client.query<{ pg_backend_pid: number }>('SELECT pg_backend_pid()'))
    )
    expect(backends[0].rows[0].pg_backend_pid).not.toBe(backends[1].rows[0].pg_backend_pid)

    const gate = twoArrivalGate()
    beforeVerificationInsert = gate.wait

    const competitor = { ...owner, user_id: 'user-2' }
    const results = await Promise.allSettled([
      first.saveVerificationResult(owner),
      second.saveVerificationResult(competitor),
    ])
    expect(gate.arrivals()).toBe(2)
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.any(VerificationResultConflictError) }),
    ])

    const rows = await admin.query<{ user_id: string }>(
      `SELECT user_id FROM ${schema}.integration_api_verification_results
       WHERE guild_id = $1 AND nullifier_hash = $2`,
      [owner.guild_id, owner.nullifier_hash]
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].user_id).toBe(
      results[0].status === 'fulfilled' ? owner.user_id : competitor.user_id
    )
  })
})
