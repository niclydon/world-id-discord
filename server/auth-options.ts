import { createGuildCommands } from '@/lib/discord/create-guild-commands'
import { AuthOptions } from 'next-auth'
import DiscordProvider from 'next-auth/providers/discord'
import type { Account } from 'next-auth'
import { resolveSignInGuild } from './resolve-signin-guild'

const CLIENT_ID = process.env.DISCORD_APP_ID
const CLIENT_SECRET = process.env.DISCORD_APP_SECRET
const scope = ['identify', 'bot', 'applications.commands'].join(' ')
const permissions = '268435456'

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error('DISCORD_APP_ID and DISCORD_APP_SECRET must be set')
}

export const authOptions: AuthOptions = {
  providers: [
    DiscordProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      authorization: { params: { scope, permissions } },
    }),
  ],

  callbacks: {
    async signIn({ account }) {
      if (!account) {
        console.error('[auth] signIn rejected: reason=no-account')
        return false
      }

      if (!account.guild?.id) {
        const accessToken = account.access_token
        const botToken = process.env.DISCORD_BOT_TOKEN

        if (!accessToken || !botToken) {
          console.error(
            '[auth] signIn rejected: reason=no-guild-in-token-response,fallback-unavailable'
          )
          return false
        }

        const resolution = await resolveSignInGuild(accessToken, botToken)

        if (resolution.status === 'no-qualifying-guild') {
          console.error(
            '[auth] signIn rejected: reason=no-guild-in-token-response,no-qualifying-guild'
          )
          return false
        }

        if (resolution.status === 'ambiguous') {
          console.error(
            `[auth] signIn rejected: reason=no-guild-in-token-response,ambiguous-guilds,count=${resolution.qualifyingCount}`
          )
          return false
        }

        if (resolution.status === 'lookup-failed') {
          console.error(
            '[auth] signIn rejected: reason=no-guild-in-token-response,guild-lookup-failed'
          )
          return false
        }

        // Discord omits the guild from the token response when the bot is
        // already a member of the guild picked in the authorize step, so the
        // fallback resolves it from the user's and the bot's guild lists.
        // NextAuth passes this same account object on to the jwt callback,
        // so assigning the guild here binds it into the session through the
        // existing jwt/session callbacks. Only the fields those callbacks
        // read (id, name, icon) are populated.
        account.guild = resolution.guild as NonNullable<Account['guild']>
      }

      const guildId = account.guild?.id

      if (!guildId) {
        console.error('[auth] signIn rejected: reason=no-guild-after-resolution')
        return false
      }

      try {
        await createGuildCommands(guildId)
      } catch (error) {
        console.error('Error creating guild commands', error)
      }

      return true
    },

    async jwt({ token, account }) {
      const guildId = account?.guild?.id

      if (guildId) {
        token.guildId = guildId
        token.guildName = account?.guild?.name
        token.guildIcon = account?.guild?.icon
      }

      return token
    },

    async session({ session, token }) {
      session.user.id = token.sub

      const guildId = token.guildId

      if (guildId) {
        session.guild = {
          id: token.guildId,
          name: token.guildName,
          icon: token.guildIcon,
        }
      }

      return session
    },
  },
}
