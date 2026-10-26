import { PermissionFlagsBits, Routes } from 'discord-api-types/v10'
import type { RESTAPIPartialCurrentUserGuild } from 'discord-api-types/v10'

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10'
const GUILD_PAGE_SIZE = 200
const MAX_BOT_GUILD_PAGES = 25

export type SignInGuild = {
  id: string
  name: string
  icon: string | null
}

export type SignInGuildResolution =
  | { status: 'resolved'; guild: SignInGuild }
  | { status: 'no-qualifying-guild' }
  | { status: 'ambiguous'; qualifyingCount: number }
  | { status: 'lookup-failed' }

const fetchCurrentUserGuildPage = async (
  authorization: string,
  after?: string
): Promise<RESTAPIPartialCurrentUserGuild[]> => {
  const url = new URL(`${DISCORD_API_BASE_URL}${Routes.userGuilds()}`)
  url.searchParams.set('limit', String(GUILD_PAGE_SIZE))
  if (after) {
    url.searchParams.set('after', after)
  }

  const response = await fetch(url, {
    headers: { Authorization: authorization },
  })

  if (!response.ok) {
    throw new Error(`Discord guild lookup failed with status ${response.status}`)
  }

  const guilds: unknown = await response.json()
  if (!Array.isArray(guilds) || guilds.length > GUILD_PAGE_SIZE) {
    throw new Error('Discord guild lookup returned an invalid page')
  }

  return guilds as RESTAPIPartialCurrentUserGuild[]
}

const fetchBotGuilds = async (botToken: string): Promise<RESTAPIPartialCurrentUserGuild[]> => {
  const guilds: RESTAPIPartialCurrentUserGuild[] = []
  const seenGuildIds = new Set<string>()
  let after: string | undefined

  for (let pageNumber = 0; pageNumber < MAX_BOT_GUILD_PAGES; pageNumber += 1) {
    const page = await fetchCurrentUserGuildPage(`Bot ${botToken}`, after)

    for (const guild of page) {
      if (!guild || typeof guild.id !== 'string' || seenGuildIds.has(guild.id)) {
        throw new Error('Discord guild lookup returned a repeated or invalid guild')
      }
      seenGuildIds.add(guild.id)
    }

    guilds.push(...page)
    if (page.length < GUILD_PAGE_SIZE) {
      return guilds
    }

    // Discord's `after` cursor is the last guild ID on the preceding page.
    after = page[page.length - 1].id
  }

  // A full final page does not prove the list ended. Do not resolve a guild
  // from a partial bot inventory, even when one candidate was already found.
  throw new Error('Discord bot guild lookup exceeded the page limit')
}

const guildManagementPermissions =
  PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild

const userCanManageGuild = (guild: RESTAPIPartialCurrentUserGuild): boolean => {
  if (guild.owner) {
    return true
  }

  return (BigInt(guild.permissions) & guildManagementPermissions) !== BigInt(0)
}

// Fallback for sign-ins where Discord's token response carries no guild
// (notably re-authorization when the bot already belongs to the selected
// guild). The sign-in guild is the single guild that both the user and the
// bot belong to and that the user can administer. Anything else (none,
// several, a failed lookup) is reported distinctly and stays fail-closed.
export const resolveSignInGuild = async (
  accessToken: string,
  botToken: string
): Promise<SignInGuildResolution> => {
  const guildLists = await Promise.all([
    fetchCurrentUserGuildPage(`Bearer ${accessToken}`),
    fetchBotGuilds(botToken),
  ]).catch(() => null)

  if (!guildLists) {
    return { status: 'lookup-failed' }
  }

  const [userGuilds, botGuilds] = guildLists

  const botGuildIds = new Set(botGuilds.map(guild => guild.id))

  const qualifyingGuilds = userGuilds.filter(
    guild => botGuildIds.has(guild.id) && userCanManageGuild(guild)
  )

  if (qualifyingGuilds.length === 0) {
    return { status: 'no-qualifying-guild' }
  }

  if (qualifyingGuilds.length > 1) {
    return { status: 'ambiguous', qualifyingCount: qualifyingGuilds.length }
  }

  const [guild] = qualifyingGuilds

  return {
    status: 'resolved',
    guild: { id: guild.id, name: guild.name, icon: guild.icon },
  }
}
