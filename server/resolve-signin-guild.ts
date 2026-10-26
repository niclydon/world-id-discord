import { PermissionFlagsBits, Routes } from 'discord-api-types/v10'
import type { RESTAPIPartialCurrentUserGuild } from 'discord-api-types/v10'

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10'

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

const fetchCurrentUserGuilds = async (
  authorization: string
): Promise<RESTAPIPartialCurrentUserGuild[]> => {
  const response = await fetch(`${DISCORD_API_BASE_URL}${Routes.userGuilds()}`, {
    headers: { Authorization: authorization },
  })

  if (!response.ok) {
    throw new Error(`Discord guild lookup failed with status ${response.status}`)
  }

  return (await response.json()) as RESTAPIPartialCurrentUserGuild[]
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
    fetchCurrentUserGuilds(`Bearer ${accessToken}`),
    fetchCurrentUserGuilds(`Bot ${botToken}`),
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
