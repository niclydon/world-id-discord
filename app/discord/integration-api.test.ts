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
  vi.stubEnv('INTEGRATION_API_STORE_FILE', ':memory:')

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
    })
  })

  it('treats a second save for the same key as an upsert', async () => {
    await client.saveVerificationResult(item)
    await client.saveVerificationResult({ ...item, userId: 'user-2' })

    await expect(
      client.fetchVerificationResult({
        guildId: item.guildId,
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toMatchObject({ user_id: 'user-2' })
  })

  it('keys records by guild and nullifier together', async () => {
    await expect(
      client.fetchVerificationResult({
        guildId: guildId('other-guild'),
        nullifierHash: item.nullifierHash,
      })
    ).resolves.toBeNull()
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
