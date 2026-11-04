import { createGuildCommands } from '@/lib/discord/create-guild-commands'
import type { RESTAPIPartialCurrentUserGuild } from 'discord-api-types/v10'
import type { Account, AuthOptions } from 'next-auth'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/discord/create-guild-commands', () => ({
  createGuildCommands: vi.fn(),
}))

const ACCESS_TOKEN = 'user-access-token'
const BOT_TOKEN = 'bot-token-value'

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', fetchMock)

type Callbacks = NonNullable<AuthOptions['callbacks']>
type SignInCallback = NonNullable<Callbacks['signIn']>
type JwtCallback = NonNullable<Callbacks['jwt']>

let signInCallback: SignInCallback
let jwtCallback: JwtCallback

beforeAll(async () => {
  process.env.DISCORD_APP_ID = 'discord-app-id'
  process.env.DISCORD_APP_SECRET = 'discord-app-secret'
  process.env.DISCORD_BOT_TOKEN = BOT_TOKEN

  const { authOptions } = await import('./auth-options')

  if (!authOptions.callbacks?.signIn || !authOptions.callbacks?.jwt) {
    throw new Error('Expected the signIn and jwt callbacks to be defined')
  }

  signInCallback = authOptions.callbacks.signIn
  jwtCallback = authOptions.callbacks.jwt
})

const callSignIn = (account: Account | null) =>
  signInCallback({ account } as Parameters<SignInCallback>[0])

const callJwt = (account: Account) =>
  jwtCallback({ token: { sub: 'user-1' }, account } as Parameters<JwtCallback>[0])

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  provider: 'discord',
  type: 'oauth',
  providerAccountId: 'user-1',
  access_token: ACCESS_TOKEN,
  ...overrides,
})

const tokenGuild = (): NonNullable<Account['guild']> => ({
  id: 'guild-token',
  name: 'Token Guild',
  icon: null,
  description: null,
  owner_id: 'user-1',
  features: [],
  roles: [],
  verification_level: 0,
  preferred_locale: 'en-US',
})

const partialGuild = (
  overrides: Partial<RESTAPIPartialCurrentUserGuild> = {}
): RESTAPIPartialCurrentUserGuild => ({
  id: 'guild-1',
  name: 'Guild One',
  icon: null,
  banner: null,
  owner: false,
  features: [],
  permissions: '0',
  ...overrides,
})

const botGuildPage = (firstId: number, count = 200) =>
  Array.from({ length: count }, (_, index) => partialGuild({ id: String(firstId + index) }))

const mockGuildEndpoints = (
  userGuilds: RESTAPIPartialCurrentUserGuild[],
  botGuilds: RESTAPIPartialCurrentUserGuild[]
) => {
  fetchMock.mockImplementation(async (_input, init) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization

    if (authorization === `Bearer ${ACCESS_TOKEN}`) {
      return new Response(JSON.stringify(userGuilds), { status: 200 })
    }

    if (authorization === `Bot ${BOT_TOKEN}`) {
      return new Response(JSON.stringify(botGuilds), { status: 200 })
    }

    return new Response('unexpected authorization header', { status: 401 })
  })
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(createGuildCommands).mockResolvedValue(undefined as never)
})

describe('authOptions signIn callback', () => {
  it('accepts a guild carried in the token response without any fallback lookup', async () => {
    const account = makeAccount({ guild: tokenGuild() })

    await expect(callSignIn(account)).resolves.toBe(true)

    expect(createGuildCommands).toHaveBeenCalledWith('guild-token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the guild by fallback when the token response omits it and one guild qualifies', async () => {
    mockGuildEndpoints(
      [
        partialGuild({ id: 'guild-admin', name: 'Admin Guild', permissions: '8' }),
        partialGuild({ id: 'guild-shared', name: 'Shared Guild', permissions: '0' }),
        partialGuild({ id: 'guild-without-bot', name: 'Owner Guild', owner: true }),
      ],
      [partialGuild({ id: 'guild-admin' }), partialGuild({ id: 'guild-shared' })]
    )

    const account = makeAccount()

    await expect(callSignIn(account)).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(account.guild).toMatchObject({
      id: 'guild-admin',
      name: 'Admin Guild',
      icon: null,
    })
    expect(createGuildCommands).toHaveBeenCalledWith('guild-admin')

    const token = await callJwt(account)

    expect(token).toMatchObject({
      guildId: 'guild-admin',
      guildName: 'Admin Guild',
      guildIcon: null,
    })
  })

  it('counts guild ownership as qualifying in the fallback', async () => {
    mockGuildEndpoints(
      [partialGuild({ id: 'guild-owned', name: 'Owned Guild', owner: true, permissions: '0' })],
      [partialGuild({ id: 'guild-owned' })]
    )

    const account = makeAccount()

    await expect(callSignIn(account)).resolves.toBe(true)
    expect(account.guild).toMatchObject({ id: 'guild-owned' })
    expect(createGuildCommands).toHaveBeenCalledWith('guild-owned')
  })

  it('resolves a managed guild beyond the first page of bot guilds', async () => {
    const firstPage = botGuildPage(1000)
    fetchMock.mockImplementation(async (input, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      const url = new URL(String(input))

      if (authorization === `Bearer ${ACCESS_TOKEN}`) {
        return new Response(
          JSON.stringify([partialGuild({ id: '1200', name: 'Later Guild', permissions: '8' })])
        )
      }

      if (authorization === `Bot ${BOT_TOKEN}`) {
        const page =
          url.searchParams.get('after') === '1199' ? botGuildPage(1200, 1) : firstPage
        return new Response(JSON.stringify(page))
      }

      return new Response(null, { status: 401 })
    })

    const account = makeAccount()
    await expect(callSignIn(account)).resolves.toBe(true)

    expect(account.guild).toMatchObject({ id: '1200', name: 'Later Guild' })
    expect(createGuildCommands).toHaveBeenCalledWith('1200')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: '?limit=200&after=1199' }),
      expect.objectContaining({ headers: { Authorization: `Bot ${BOT_TOKEN}` } })
    )
  })

  it('checks the page after exactly 200 bot guilds before resolving', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      const after = new URL(String(input)).searchParams.get('after')

      if (authorization === `Bearer ${ACCESS_TOKEN}`) {
        return new Response(JSON.stringify([partialGuild({ id: '1000', permissions: '8' })]))
      }

      if (authorization === `Bot ${BOT_TOKEN}`) {
        return new Response(JSON.stringify(after ? [] : botGuildPage(1000)))
      }

      return new Response(null, { status: 401 })
    })

    await expect(callSignIn(makeAccount())).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(createGuildCommands).toHaveBeenCalledWith('1000')
  })

  it('rejects when a second managed guild appears on a later bot page', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      const after = new URL(String(input)).searchParams.get('after')

      if (authorization === `Bearer ${ACCESS_TOKEN}`) {
        return new Response(
          JSON.stringify([
            partialGuild({ id: '1000', permissions: '8' }),
            partialGuild({ id: '1200', permissions: '32' }),
          ])
        )
      }

      if (authorization === `Bot ${BOT_TOKEN}`) {
        return new Response(JSON.stringify(after ? botGuildPage(1200, 1) : botGuildPage(1000)))
      }

      return new Response(null, { status: 401 })
    })

    await expect(callSignIn(makeAccount())).resolves.toBe(false)
    expect(createGuildCommands).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no-guild-in-token-response,ambiguous-guilds,count=2')
    )
  })

  it('rejects when the bounded bot lookup cannot prove its guild list is complete', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      const after = new URL(String(input)).searchParams.get('after')

      if (authorization === `Bearer ${ACCESS_TOKEN}`) {
        return new Response(JSON.stringify([partialGuild({ id: '1000', permissions: '8' })]))
      }

      if (authorization === `Bot ${BOT_TOKEN}`) {
        return new Response(JSON.stringify(botGuildPage(after ? Number(after) + 1 : 1000)))
      }

      return new Response(null, { status: 401 })
    })

    await expect(callSignIn(makeAccount())).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(26)
    expect(createGuildCommands).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no-guild-in-token-response,guild-lookup-failed')
    )
  })

  it('rejects a repeated bot guild page instead of resolving from an incomplete list', async () => {
    mockGuildEndpoints([partialGuild({ id: '1000', permissions: '8' })], botGuildPage(1000))

    await expect(callSignIn(makeAccount())).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(createGuildCommands).not.toHaveBeenCalled()
  })

  it('rejects when the token response omits the guild and no guild qualifies', async () => {
    mockGuildEndpoints(
      [
        partialGuild({ id: 'guild-shared', permissions: '0' }),
        partialGuild({ id: 'guild-admin-elsewhere', permissions: '8' }),
      ],
      [partialGuild({ id: 'guild-shared' })]
    )

    await expect(callSignIn(makeAccount())).resolves.toBe(false)

    expect(createGuildCommands).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no-guild-in-token-response,no-qualifying-guild')
    )
  })

  it('rejects when the token response omits the guild and two guilds qualify', async () => {
    mockGuildEndpoints(
      [
        partialGuild({ id: 'guild-admin', permissions: '8' }),
        partialGuild({ id: 'guild-managed', permissions: '32' }),
      ],
      [partialGuild({ id: 'guild-admin' }), partialGuild({ id: 'guild-managed' })]
    )

    await expect(callSignIn(makeAccount())).resolves.toBe(false)

    expect(createGuildCommands).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no-guild-in-token-response,ambiguous-guilds,count=2')
    )
  })

  it('rejects without throwing when the Discord guild lookup fails', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'))

    await expect(callSignIn(makeAccount())).resolves.toBe(false)

    expect(createGuildCommands).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no-guild-in-token-response,guild-lookup-failed')
    )
  })

  it('rejects when Discord answers the guild lookup with an error status', async () => {
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }))

    await expect(callSignIn(makeAccount())).resolves.toBe(false)

    expect(createGuildCommands).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no-guild-in-token-response,guild-lookup-failed')
    )
  })
})

describe('authOptions Discord provider configuration', () => {
  const providerConfig = async () => {
    const { authOptions } = await import('./auth-options')
    const provider = (authOptions.providers[0] ?? {}) as unknown as Record<string, unknown>

    return {
      ...provider,
      ...((provider.options as Record<string, unknown> | undefined) ?? {}),
    } as {
      issuer?: string
      authorization?: { params?: { scope?: string } }
    }
  }

  it('configures the Discord issuer so the OAuth callback can validate the iss response parameter', async () => {
    const provider = await providerConfig()

    expect(provider.issuer).toBe('https://discord.com')
  })

  it("requests the guilds scope so the fallback can read the user's guilds", async () => {
    const provider = await providerConfig()

    expect(provider.authorization?.params?.scope?.split(' ')).toContain('guilds')
  })
})
