import { BotConfig } from '@/schemas/bot-config'
import { VerificationResultItem } from '@/schemas/verification-result-item'
import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

/**
 * Persistence for the self-hosted Discord integration API.
 *
 * The store keeps exactly the two record kinds the integration API client
 * exchanges: bot configs keyed by guild id, and verification results keyed
 * by (guild id, nullifier hash).
 *
 * Backend selection, in order:
 * 1. Postgres, when INTEGRATION_API_DATABASE_URL or DATABASE_URL is set
 *    (the Neon integration on Vercel injects DATABASE_URL when a database
 *    is connected to the project). This is the durable production backend.
 * Postgres is required by default so concurrent instances share an atomic
 * nullifier ownership constraint. Explicit local development and tests can
 * use a JSON file at INTEGRATION_API_STORE_FILE (':memory:' selects
 * process-local memory), or a JSON file under the OS temp directory.
 */
export interface IntegrationApiStore {
  getBotConfig: (guildId: string) => Promise<BotConfig | null>
  saveBotConfig: (botConfig: BotConfig) => Promise<void>
  getVerificationResult: (
    guildId: string,
    nullifierHash: string
  ) => Promise<VerificationResultItem | null>
  saveVerificationResult: (item: VerificationResultItem) => Promise<void>
}

type StoreData = {
  botConfigs: Record<string, BotConfig>
  verificationResults: Record<string, VerificationResultItem>
}

const emptyData = (): StoreData => ({ botConfigs: {}, verificationResults: {} })

const verificationKey = (guildId: string, nullifierHash: string) =>
  JSON.stringify([guildId, nullifierHash])

export class VerificationResultConflictError extends Error {
  constructor() {
    super('Verification result conflicts with an existing record')
    this.name = 'VerificationResultConflictError'
  }
}

const sameVerificationResult = (left: VerificationResultItem, right: VerificationResultItem) =>
  left.guild_id === right.guild_id &&
  left.nullifier_hash === right.nullifier_hash &&
  left.signal_type === right.signal_type &&
  left.user_id === right.user_id &&
  left.environment === right.environment

class MemoryStore implements IntegrationApiStore {
  constructor(private data: StoreData = emptyData()) {}

  snapshot(): StoreData {
    return this.data
  }

  async getBotConfig(guildId: string) {
    return this.data.botConfigs[guildId] ?? null
  }

  async saveBotConfig(botConfig: BotConfig) {
    this.data.botConfigs[botConfig.guild_id] = botConfig
  }

  async getVerificationResult(guildId: string, nullifierHash: string) {
    return this.data.verificationResults[verificationKey(guildId, nullifierHash)] ?? null
  }

  async saveVerificationResult(item: VerificationResultItem) {
    const key = verificationKey(item.guild_id, item.nullifier_hash)
    const existing = this.data.verificationResults[key]

    if (existing && !sameVerificationResult(existing, item)) {
      throw new VerificationResultConflictError()
    }

    if (!existing) {
      this.data.verificationResults[key] = item
    }
  }
}

class FileStore implements IntegrationApiStore {
  private memory = new MemoryStore()
  private loadPromise: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private filePath: string) {}

  private async load() {
    if (!this.loadPromise) {
      this.loadPromise = this.readFromDisk()
    }

    await this.loadPromise
  }

  private async readFromDisk() {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }

      throw error
    }

    const parsed = JSON.parse(raw) as Partial<StoreData>

    for (const botConfig of Object.values(parsed.botConfigs ?? {})) {
      await this.memory.saveBotConfig(botConfig)
    }

    for (const item of Object.values(parsed.verificationResults ?? {})) {
      await this.memory.saveVerificationResult(item)
    }
  }

  private async persist(data: StoreData) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`

    try {
      await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8')
      await fs.rename(temporaryPath, this.filePath)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async run<T>(operation: (candidate: MemoryStore) => Promise<T>): Promise<T> {
    let result: T

    const task = async () => {
      await this.load()
      const snapshot = this.memory.snapshot()
      const candidate = new MemoryStore({
        botConfigs: { ...snapshot.botConfigs },
        verificationResults: { ...snapshot.verificationResults },
      })
      result = await operation(candidate)
      await this.persist(candidate.snapshot())
      this.memory = candidate
    }

    this.queue = this.queue.then(task, task)
    await this.queue

    return result!
  }

  async getBotConfig(guildId: string) {
    await this.load()
    return this.memory.getBotConfig(guildId)
  }

  async saveBotConfig(botConfig: BotConfig) {
    await this.run(async candidate => {
      await candidate.saveBotConfig(botConfig)
    })
  }

  async getVerificationResult(guildId: string, nullifierHash: string) {
    await this.load()
    return this.memory.getVerificationResult(guildId, nullifierHash)
  }

  async saveVerificationResult(item: VerificationResultItem) {
    await this.run(async candidate => {
      await candidate.saveVerificationResult(item)
    })
  }
}

class PostgresStore implements IntegrationApiStore {
  private sql: ReturnType<typeof neon>
  private initialized: Promise<void> | null = null

  constructor(connectionString: string) {
    this.sql = neon(connectionString)
  }

  private async init() {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.sql.query(
          `DO $$
          BEGIN
            -- One HTTP query is one transaction. This lock serializes cold
            -- starts across instances: concurrent CREATE TABLE IF NOT EXISTS
            -- can otherwise fail while PostgreSQL creates the table's type.
            PERFORM pg_advisory_xact_lock(
              hashtext('world-id-discord.integration-api'), hashtext(current_schema())
            );
            CREATE TABLE IF NOT EXISTS integration_api_bot_configs (
              guild_id text PRIMARY KEY,
              config jsonb NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_api_verification_results (
              guild_id text NOT NULL,
              nullifier_hash text NOT NULL,
              signal_type text NOT NULL,
              user_id text NOT NULL,
              environment text NOT NULL,
              PRIMARY KEY (guild_id, nullifier_hash)
            );
            -- Older rows have no environment and remain untrusted.
            ALTER TABLE integration_api_verification_results
              ADD COLUMN IF NOT EXISTS environment text;
          END $$`
        )
      })().catch(error => {
        this.initialized = null
        throw error
      })
    }

    await this.initialized
  }

  async getBotConfig(guildId: string) {
    await this.init()
    const rows = (await this.sql.query(
      'SELECT config FROM integration_api_bot_configs WHERE guild_id = $1',
      [guildId]
    )) as Array<{ config: BotConfig }>

    return rows.length > 0 ? rows[0].config : null
  }

  async saveBotConfig(botConfig: BotConfig) {
    await this.init()
    await this.sql.query(
      `INSERT INTO integration_api_bot_configs (guild_id, config)
       VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET config = EXCLUDED.config`,
      [botConfig.guild_id, JSON.stringify(botConfig)]
    )
  }

  async getVerificationResult(guildId: string, nullifierHash: string) {
    await this.init()
    const rows = (await this.sql.query(
      `SELECT guild_id, nullifier_hash, signal_type, user_id, environment
       FROM integration_api_verification_results
       WHERE guild_id = $1 AND nullifier_hash = $2`,
      [guildId, nullifierHash]
    )) as VerificationResultItem[]

    return rows.length > 0 ? rows[0] : null
  }

  async saveVerificationResult(item: VerificationResultItem) {
    await this.init()
    const rows = (await this.sql.query(
      `INSERT INTO integration_api_verification_results
        (guild_id, nullifier_hash, signal_type, user_id, environment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (guild_id, nullifier_hash) DO UPDATE SET
        user_id = integration_api_verification_results.user_id
       WHERE integration_api_verification_results.user_id = EXCLUDED.user_id
         AND integration_api_verification_results.signal_type = EXCLUDED.signal_type
         AND integration_api_verification_results.environment = EXCLUDED.environment
       RETURNING guild_id`,
      [item.guild_id, item.nullifier_hash, item.signal_type, item.user_id, item.environment]
    )) as Array<{ guild_id: string }>

    if (rows.length === 0) {
      throw new VerificationResultConflictError()
    }
  }
}

const databaseUrl = () => process.env.INTEGRATION_API_DATABASE_URL || process.env.DATABASE_URL

const localStoreAllowed = () =>
  process.env.INTEGRATION_API_ALLOW_LOCAL_STORE === 'true' &&
  process.env.NEXT_PUBLIC_APP_ENV === 'development' &&
  !process.env.VERCEL &&
  !process.env.VERCEL_ENV &&
  (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')

const assertStorePolicy = () => {
  if (!databaseUrl() && !localStoreAllowed()) {
    throw new Error('Discord integration API requires a Postgres database URL')
  }
}

const createStore = (): IntegrationApiStore => {
  assertStorePolicy()
  const connectionString = databaseUrl()

  if (connectionString) {
    return new PostgresStore(connectionString)
  }

  const storeFile = process.env.INTEGRATION_API_STORE_FILE

  if (storeFile === ':memory:') {
    return new MemoryStore()
  }

  return new FileStore(
    storeFile ?? path.join(os.tmpdir(), 'world-id-discord-integration-api.json')
  )
}

const globalStore = globalThis as unknown as {
  integrationApiStore?: IntegrationApiStore
}

export const getIntegrationApiStore = (): IntegrationApiStore => {
  // Recheck on every call so a cached local store cannot survive a runtime
  // configuration change into a deployed environment.
  assertStorePolicy()

  if (
    !globalStore.integrationApiStore ||
    (databaseUrl() && !(globalStore.integrationApiStore instanceof PostgresStore)) ||
    (!databaseUrl() && globalStore.integrationApiStore instanceof PostgresStore)
  ) {
    globalStore.integrationApiStore = createStore()
  }

  return globalStore.integrationApiStore
}
