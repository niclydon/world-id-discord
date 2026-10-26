import { BotConfig } from '@/schemas/bot-config'
import { VerificationResultItem } from '@/schemas/verification-result-item'
import { neon } from '@neondatabase/serverless'
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
 * 2. A JSON file at INTEGRATION_API_STORE_FILE (the literal value
 *    ':memory:' selects a process-local in-memory store, used by tests).
 * 3. A JSON file under the OS temp directory, so local development and
 *    trials work with no configuration. Records there survive warm
 *    restarts of a single instance only; connect a database for real
 *    durability.
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
  `${guildId}:${nullifierHash}`

class MemoryStore implements IntegrationApiStore {
  private data: StoreData = emptyData()

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
    this.data.verificationResults[verificationKey(item.guild_id, item.nullifier_hash)] = item
  }
}

class FileStore implements IntegrationApiStore {
  private memory = new MemoryStore()
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private filePath: string) {}

  private async load() {
    if (this.loaded) {
      return
    }

    this.loaded = true

    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoreData>

      for (const botConfig of Object.values(parsed.botConfigs ?? {})) {
        await this.memory.saveBotConfig(botConfig)
      }

      for (const item of Object.values(parsed.verificationResults ?? {})) {
        await this.memory.saveVerificationResult(item)
      }
    } catch {
      // A missing or unreadable file simply starts as an empty store.
    }
  }

  private async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.memory.snapshot(), null, 2), 'utf8')
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    let result: T

    const task = async () => {
      await this.load()
      result = await operation()
      await this.persist()
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
    await this.run(async () => {
      await this.memory.saveBotConfig(botConfig)
    })
  }

  async getVerificationResult(guildId: string, nullifierHash: string) {
    await this.load()
    return this.memory.getVerificationResult(guildId, nullifierHash)
  }

  async saveVerificationResult(item: VerificationResultItem) {
    await this.run(async () => {
      await this.memory.saveVerificationResult(item)
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
          `CREATE TABLE IF NOT EXISTS integration_api_bot_configs (
            guild_id text PRIMARY KEY,
            config jsonb NOT NULL
          )`
        )
        await this.sql.query(
          `CREATE TABLE IF NOT EXISTS integration_api_verification_results (
            guild_id text NOT NULL,
            nullifier_hash text NOT NULL,
            signal_type text NOT NULL,
            user_id text NOT NULL,
            PRIMARY KEY (guild_id, nullifier_hash)
          )`
        )
      })()
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
      `SELECT guild_id, nullifier_hash, signal_type, user_id
       FROM integration_api_verification_results
       WHERE guild_id = $1 AND nullifier_hash = $2`,
      [guildId, nullifierHash]
    )) as VerificationResultItem[]

    return rows.length > 0 ? rows[0] : null
  }

  async saveVerificationResult(item: VerificationResultItem) {
    await this.init()
    await this.sql.query(
      `INSERT INTO integration_api_verification_results
        (guild_id, nullifier_hash, signal_type, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, nullifier_hash) DO UPDATE SET
        signal_type = EXCLUDED.signal_type,
        user_id = EXCLUDED.user_id`,
      [item.guild_id, item.nullifier_hash, item.signal_type, item.user_id]
    )
  }
}

const createStore = (): IntegrationApiStore => {
  const connectionString = process.env.INTEGRATION_API_DATABASE_URL ?? process.env.DATABASE_URL

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
  if (!globalStore.integrationApiStore) {
    globalStore.integrationApiStore = createStore()
  }

  return globalStore.integrationApiStore
}
