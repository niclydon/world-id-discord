import { botConfigSchema, BotConfig } from '@/schemas/bot-config'
import { CredentialType } from '@/types/credential-type'
import { getAppUrl } from '@/utils/get-app-url'
import { SignJWT } from 'jose'
import { NextRequest } from 'next/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end contract tests for the self-hosted Discord integration API.
 *
 * The real client functions from lib/discord-integration-api run against
 * the real route handlers under app/discord, with global fetch stubbed to
 * dispatch into the handlers. This exercises the exact contract the client
 * was written against: routes, query and body shapes, the JWT the client
 * signs, and the response envelope it parses.
 */

const SIGN_SECRET = 'test-integration-api-sign-secret'
const API_URL = 'https://integration.test'

type Client = {
  fetchBotConfig: typeof import('@/lib/discord-integration-api/fetch-bot-config').fetchBotConfig
  saveBotConfig: typeof import('@/lib/discord-integration-api/save-bot-config').saveBotConfig
  fetchVerificationResult: typeof import('@/lib/discord-integration-api/fetch-verification-result').fetchVerificationResult
  saveVerificationResult: typeof import('@/lib/discord-integration-api/save-verification-result').saveVerificationResult
}

type Routes = {
  botConfigGET: typeof import('./bot-config/route').GET
  botConfigPOST: typeof import('./bot-config/route').POST
  verificationResultGET: typeof import('./verification-result/route').GET
  verificationResultPOST: typeof import('./verification-result/route').POST
}

let client: Client
let routes: Routes

const dispatchFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.toString())
  const request = new NextRequest(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  })

  if (url.pathname === '/discord/bot-config') {
    return request.method === 'POST'
      ? routes.botConfigPOST(request)
      : routes.botConfigGET(request)
  }

  if (url.pathname === '/discord/verification-result') {
    return request.method === 'POST'
      ? routes.verificationResultPOST(request)
      : routes.verificationResultGET(request)
  }

  throw new Error(`Unexpected fetch in test: ${url.toString()}`)
}

const signToken = async ({
  secret = SIGN_SECRET,
  audience = API_URL,
}: { secret?: string; audience?: string } = {}) => {
  const appUrl = getAppUrl().toString()
  const issuer = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl
  const now = Math.floor(Date.now() / 1000)

  return await new SignJWT({ sub: 'discord-integration' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(secret))
}

const guildId = (suffix: string) => `guild-${suffix}`

const makeBotConfig = (guild: string): BotConfig => ({
  guild_id: guild,
  enabled: true,
  device: { enabled: false, roles: [] },
  orb: { enabled: true, roles: ['role-verified'] },
})

beforeAll(async () => {
  vi.stubEnv('DISCORD_INTEGRATION_API_URL', API_URL)
  vi.stubEnv('DISCORD_INTEGRATION_API_SIGN_SECRET', SIGN_SECRET)
  vi.stubEnv('INTEGRATION_API_DATABASE_URL', '')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('INTEGRATION_API_STORE_FILE', ':memory:')
  vi.stubEnv('INTEGRATION_API_ALLOW_LOCAL_STORE', 'true')
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'development')

  const [fetchBotConfigModule, saveBotConfigModule, fetchResultModule, saveResultModule] =
    await Promise.all([
      import('@/lib/discord-integration-api/fetch-bot-config'),
      import('@/lib/discord-integration-api/save-bot-config'),
      import('@/lib/discord-integration-api/fetch-verification-result'),
      import('@/lib/discord-integration-api/save-verification-result'),
    ])

  client = {
    fetchBotConfig: fetchBotConfigModule.fetchBotConfig,
    saveBotConfig: saveBotConfigModule.saveBotConfig,
    fetchVerificationResult: fetchResultModule.fetchVerificationResult,
    saveVerificationResult: saveResultModule.saveVerificationResult,
  }

  const [botConfigRoute, verificationResultRoute] = await Promise.all([
    import('./bot-config/route'),
    import('./verification-result/route'),
  ])

  routes = {
    botConfigGET: botConfigRoute.GET,
    botConfigPOST: botConfigRoute.POST,
    verificationResultGET: verificationResultRoute.GET,
    verificationResultPOST: verificationResultRoute.POST,
  }

  vi.stubGlobal('fetch', dispatchFetch)
})

describe('bot config', () => {
  it('returns null for a guild with no saved config', async () => {
    await expect(client.fetchBotConfig(guildId('unknown'))).resolves.toBeNull()
  })

  it('saves a config and fetches it back in the documented shape', async () => {
    const botConfig = makeBotConfig(guildId('roundtrip'))

    await client.saveBotConfig({ botConfig, guildId: botConfig.guild_id })

    const fetched = await client.fetchBotConfig(botConfig.guild_id)

    expect(fetched).toEqual(botConfig)
    expect(botConfigSchema.parse(fetched)).toEqual(botConfig)
  })
})

describe('verification result', () => {
  const item = {
    guildId: guildId('results'),
    nullifierHash: '0xabc123',
    credentialType: CredentialType.Orb,
    userId: 'user-1',
    environment: 'production' as const,
  }

  it('returns null when no record exists for the key', async () => {
    await expect(
      client.fetchVerificationResult({ guildId: guildId('never-saved'), nullifierHash: '0x0' })
    ).resolves.toBeNull()
  })

  it('saves a result and fetches the stored record back', async () => {
    await client.saveVerificationResult(item)

    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toEqual({
      guild_id: item.guildId,
      nullifier_hash: item.nullifierHash,
      signal_type: item.credentialType,
      user_id: item.userId,
      environment: item.environment,
    })
  })

  it('allows an exact retry without changing the stored record', async () => {
    await client.saveVerificationResult(item)
    await expect(client.saveVerificationResult(item)).resolves.toBeDefined()

    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: item.userId, signal_type: item.credentialType })
  })

  it('rejects a second user for a nullifier and preserves the first owner', async () => {
    await client.saveVerificationResult(item)

    await expect(
      client.saveVerificationResult({ ...item, userId: 'user-2' })
    ).rejects.toMatchObject({
      cause: { status: 409 },
    })

    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: item.userId, signal_type: item.credentialType })
  })

  it('rejects a credential-type change for an existing nullifier', async () => {
    await client.saveVerificationResult(item)

    await expect(
      client.saveVerificationResult({ ...item, credentialType: CredentialType.Device })
    ).rejects.toMatchObject({ cause: { status: 409 } })

    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: item.userId, signal_type: CredentialType.Orb })
  })

  it('rejects a World ID environment change for an existing nullifier', async () => {
    await client.saveVerificationResult(item)

    await expect(
      client.saveVerificationResult({ ...item, environment: 'sandbox' })
    ).rejects.toMatchObject({ cause: { status: 409 } })

    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ environment: 'production' })
  })

  it('keys records by guild and nullifier together', async () => {
    await client.saveVerificationResult(item)

    await expect(
      client.fetchVerificationResult({
        guildId: guildId('other-guild'),
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toBeNull()

    await client.saveVerificationResult({
      ...item,
      guildId: guildId('other-guild'),
      userId: 'user-2',
    })

    await expect(
      client.fetchVerificationResult({
        guildId: guildId('other-guild'),
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: 'user-2' })
    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: item.userId })
  })

  it('does not confuse guild and nullifier values containing the same separator', async () => {
    const first = { ...item, guildId: 'guild:a', nullifierHash: 'b', userId: 'user-1' }
    const second = { ...item, guildId: 'guild', nullifierHash: 'a:b', userId: 'user-2' }

    await client.saveVerificationResult(first)
    await client.saveVerificationResult(second)

    await expect(
      client.fetchVerificationResult({
        guildId: first.guildId,
        nullifierHash: first.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: first.userId })
    await expect(
      client.fetchVerificationResult({
        guildId: second.guildId,
        nullifierHash: second.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: second.userId })
  })
})

describe('store deployment policy', () => {
  it('fails both verification-result reads and writes without a shared store', async () => {
    const previousLocalOptIn = process.env.INTEGRATION_API_ALLOW_LOCAL_STORE
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    process.env.INTEGRATION_API_ALLOW_LOCAL_STORE = ''

    try {
      const token = await signToken()
      const getResponse = await routes.verificationResultGET(
        new NextRequest(
          `${API_URL}/discord/verification-result?guild_id=blocked&nullifier_hash=0x1`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
      )
      const postResponse = await routes.verificationResultPOST(
        new NextRequest(`${API_URL}/discord/verification-result`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guild_id: 'blocked',
            nullifier_hash: '0x1',
            signal_type: CredentialType.Orb,
            user_id: 'user-1',
            environment: 'production',
          }),
        })
      )

      expect(getResponse.status).toBe(500)
      expect(postResponse.status).toBe(500)
    } finally {
      if (previousLocalOptIn === undefined) {
        delete process.env.INTEGRATION_API_ALLOW_LOCAL_STORE
      } else {
        process.env.INTEGRATION_API_ALLOW_LOCAL_STORE = previousLocalOptIn
      }
      consoleError.mockRestore()
    }
  })
})

describe('authorization', () => {
  const url = `${API_URL}/discord/bot-config?guild_id=${guildId('roundtrip')}`

  it('rejects a request with a malformed token', async () => {
    const response = await routes.botConfigGET(
      new NextRequest(url, { headers: { Authorization: 'Bearer not-a-jwt' } })
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ success: false })
  })

  it('rejects a request with no authorization header', async () => {
    const response = await routes.botConfigGET(new NextRequest(url))

    expect(response.status).toBe(401)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signToken({ secret: 'a-different-secret' })
    const response = await routes.botConfigGET(
      new NextRequest(url, { headers: { Authorization: `Bearer ${token}` } })
    )

    expect(response.status).toBe(401)
  })

  it('rejects a token issued for a different audience', async () => {
    const token = await signToken({ audience: 'https://someone-else.test' })
    const response = await routes.botConfigGET(
      new NextRequest(url, { headers: { Authorization: `Bearer ${token}` } })
    )

    expect(response.status).toBe(401)
  })

  it('rejects a verification-result write with a bad token', async () => {
    const response = await routes.verificationResultPOST(
      new NextRequest(`${API_URL}/discord/verification-result`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guild_id: guildId('roundtrip'),
          nullifier_hash: '0x1',
          signal_type: 'orb',
          user_id: 'user-9',
          environment: 'production',
        }),
      })
    )

    expect(response.status).toBe(401)
  })
})

describe('request validation', () => {
  it('requires both guild_id and nullifier_hash to fetch a verification result', async () => {
    const token = await signToken()
    const response = await routes.verificationResultGET(
      new NextRequest(`${API_URL}/discord/verification-result?guild_id=g1`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ success: false })
  })
})
