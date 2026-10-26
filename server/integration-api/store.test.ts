import { VerificationResultItem } from '@/schemas/verification-result-item'
import { CredentialType } from '@/types/credential-type'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getIntegrationApiStore, VerificationResultConflictError } from './store'

const postgresQuery = vi.hoisted(() => vi.fn<(query: string) => Promise<unknown>>())

vi.mock('@neondatabase/serverless', () => ({
  neon: () => ({ query: postgresQuery }),
}))

const globalStore = globalThis as typeof globalThis & {
  integrationApiStore?: ReturnType<typeof getIntegrationApiStore>
}

const owner: VerificationResultItem = {
  guild_id: 'guild-1',
  nullifier_hash: '0xabc123',
  signal_type: CredentialType.Orb,
  user_id: 'user-1',
  environment: 'production',
}

let storeDir: string
let storeFile: string

beforeEach(async () => {
  delete globalStore.integrationApiStore
  postgresQuery.mockReset()
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-integration-store-'))
  storeFile = path.join(storeDir, 'store.json')

  vi.stubEnv('INTEGRATION_API_DATABASE_URL', '')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('INTEGRATION_API_STORE_FILE', storeFile)
  vi.stubEnv('INTEGRATION_API_ALLOW_LOCAL_STORE', 'true')
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'development')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  delete globalStore.integrationApiStore
  await fs.rm(storeDir, { recursive: true, force: true })
})

describe('Postgres initialization', () => {
  it.each([
    ['CREATE TABLE', 'CREATE TABLE IF NOT EXISTS integration_api_bot_configs'],
    ['ALTER TABLE', 'ALTER TABLE integration_api_verification_results'],
  ])(
    'retries after a transient %s failure with one shared initialization',
    async (_, failingSql) => {
      vi.stubEnv(
        'INTEGRATION_API_DATABASE_URL',
        'postgresql://example.invalid/integration_test'
      )

      let failed = false
      let holdRecovery = false
      let releaseRecovery!: () => void
      const recoveryGate = new Promise<void>(resolve => {
        releaseRecovery = resolve
      })

      postgresQuery.mockImplementation(async statement => {
        if (!failed && statement.startsWith(failingSql)) {
          failed = true
          throw new Error('database temporarily unavailable')
        }

        if (
          holdRecovery &&
          statement.startsWith('CREATE TABLE IF NOT EXISTS integration_api_bot_configs')
        ) {
          await recoveryGate
        }

        return []
      })

      const store = getIntegrationApiStore()
      const firstRequests = [store.getBotConfig('guild-1'), store.getBotConfig('guild-2')]

      await Promise.all(
        firstRequests.map(request =>
          expect(request).rejects.toThrow('database temporarily unavailable')
        )
      )
      expect(failed).toBe(true)
      expect(
        postgresQuery.mock.calls.filter(([statement]) =>
          statement.startsWith('CREATE TABLE IF NOT EXISTS integration_api_bot_configs')
        )
      ).toHaveLength(1)

      holdRecovery = true
      const retryRequests = [store.getBotConfig('guild-1'), store.getBotConfig('guild-2')]
      const retryOutcomes = Promise.allSettled(retryRequests)
      expect(
        postgresQuery.mock.calls.filter(([statement]) =>
          statement.startsWith('CREATE TABLE IF NOT EXISTS integration_api_bot_configs')
        )
      ).toHaveLength(2)

      releaseRecovery()
      await expect(retryOutcomes).resolves.toEqual([
        { status: 'fulfilled', value: null },
        { status: 'fulfilled', value: null },
      ])
      expect(
        postgresQuery.mock.calls.filter(([statement]) => statement.startsWith('SELECT config'))
      ).toHaveLength(2)
    }
  )
})

describe('file-backed verification results', () => {
  it('rejects process-local stores in production even when a file path is configured', () => {
    vi.stubEnv('NODE_ENV', 'production')

    expect(() => getIntegrationApiStore()).toThrow(/requires a Postgres database URL/)

    vi.stubEnv('INTEGRATION_API_STORE_FILE', ':memory:')
    expect(() => getIntegrationApiStore()).toThrow(/requires a Postgres database URL/)
  })

  it('fails closed with absent or mis-set runtime mode, including a cached local store', () => {
    getIntegrationApiStore()

    vi.stubEnv('NODE_ENV', '')
    expect(() => getIntegrationApiStore()).toThrow(/requires a Postgres database URL/)

    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'development')
    vi.stubEnv('VERCEL', '1')
    expect(() => getIntegrationApiStore()).toThrow(/requires a Postgres database URL/)

    vi.stubEnv('VERCEL', '')
    vi.stubEnv('INTEGRATION_API_ALLOW_LOCAL_STORE', '')
    expect(() => getIntegrationApiStore()).toThrow(/requires a Postgres database URL/)
  })

  it('denies local storage in a non-Vercel production app even with test mode and opt-in', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production')

    expect(() => getIntegrationApiStore()).toThrow(/requires a Postgres database URL/)
  })

  it('keeps the warm cache and durable file unchanged after a failed write', async () => {
    const store = getIntegrationApiStore()
    const readFile = fs.readFile.bind(fs)
    const writeSpy = vi.spyOn(fs, 'writeFile')
    writeSpy.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(store.saveVerificationResult(owner)).rejects.toThrow('disk unavailable')
    await expect(
      store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    ).resolves.toBeNull()
    await expect(fs.readFile(storeFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const otherOwner = { ...owner, user_id: 'user-2' }
    await expect(store.saveVerificationResult(otherOwner)).resolves.toBeUndefined()
    await expect(store.saveVerificationResult(owner)).rejects.toBeInstanceOf(
      VerificationResultConflictError
    )
    await expect(
      store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    ).resolves.toEqual(otherOwner)
    const persisted = JSON.parse(await readFile(storeFile, 'utf8')) as {
      verificationResults: Record<string, VerificationResultItem>
    }
    expect(Object.values(persisted.verificationResults)).toEqual([otherOwner])
  })

  it('waits for one cold-start read before a competing save', async () => {
    const persisted = JSON.stringify({ botConfigs: {}, verificationResults: { legacy: owner } })
    await fs.writeFile(storeFile, persisted)

    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const readFile = fs.readFile.bind(fs)
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async () => {
      await readGate
      return persisted
    })

    const store = getIntegrationApiStore()
    const existingOwner = store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    const competingSave = store.saveVerificationResult({ ...owner, user_id: 'user-2' })

    expect(readSpy).toHaveBeenCalledTimes(1)
    releaseRead()

    await expect(existingOwner).resolves.toEqual(owner)
    await expect(competingSave).rejects.toBeInstanceOf(VerificationResultConflictError)
    await expect(
      store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    ).resolves.toEqual(owner)
    expect(JSON.parse(await readFile(storeFile, 'utf8'))).toEqual({
      botConfigs: {},
      verificationResults: { legacy: owner },
    })
  })

  it('fails closed on malformed persisted data', async () => {
    await fs.writeFile(storeFile, '{not json')
    const store = getIntegrationApiStore()

    await expect(
      store.getVerificationResult(owner.guild_id, owner.nullifier_hash)
    ).rejects.toThrow(SyntaxError)
    await expect(store.saveVerificationResult(owner)).rejects.toThrow(SyntaxError)
    await expect(fs.readFile(storeFile, 'utf8')).resolves.toBe('{not json')
  })
})
