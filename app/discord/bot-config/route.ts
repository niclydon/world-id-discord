import { botConfigSchema } from '@/schemas/bot-config'
import { integrationApiError, integrationApiSuccess } from '@/server/integration-api/responses'
import { getIntegrationApiStore } from '@/server/integration-api/store'
import { verifyIntegrationApiRequest } from '@/server/integration-api/verify-request-auth'
import { NextRequest } from 'next/server'

/**
 * Self-hosted stand-in for the Discord integration API's bot config
 * endpoints. The client (lib/discord-integration-api) addresses these as
 * {DISCORD_INTEGRATION_API_URL}/discord/bot-config; because the client
 * builds the URL with an absolute path, the routes live at the app root.
 */
export const GET = async (request: NextRequest) => {
  if (!(await verifyIntegrationApiRequest(request))) {
    return integrationApiError('Unauthorized', 401)
  }

  const guildId = request.nextUrl.searchParams.get('guild_id')

  if (!guildId) {
    return integrationApiError('Missing guild_id query parameter', 400)
  }

  try {
    const botConfig = await getIntegrationApiStore().getBotConfig(guildId)

    if (!botConfig) {
      return integrationApiError('Bot config not found', 404)
    }

    return integrationApiSuccess(botConfig)
  } catch (error) {
    console.error('Error fetching bot config', error)
    return integrationApiError('Internal server error', 500)
  }
}

export const POST = async (request: NextRequest) => {
  if (!(await verifyIntegrationApiRequest(request))) {
    return integrationApiError('Unauthorized', 401)
  }

  const body = (await request.json().catch(() => null)) as {
    guild_id?: unknown
    bot_config?: unknown
  } | null

  if (!body || typeof body.guild_id !== 'string' || !body.guild_id) {
    return integrationApiError('Missing guild_id in request body', 400)
  }

  // The client also passes the guild id as a `guildId` query parameter;
  // when present it must agree with the body.
  const queryGuildId = request.nextUrl.searchParams.get('guildId')

  if (queryGuildId && queryGuildId !== body.guild_id) {
    return integrationApiError('guildId query parameter does not match guild_id', 400)
  }

  const parsed = botConfigSchema.safeParse(body.bot_config)

  if (!parsed.success) {
    return integrationApiError('Invalid bot_config in request body', 400)
  }

  if (parsed.data.guild_id !== body.guild_id) {
    return integrationApiError('bot_config guild_id does not match guild_id', 400)
  }

  try {
    await getIntegrationApiStore().saveBotConfig(parsed.data)
    return integrationApiSuccess()
  } catch (error) {
    console.error('Error saving bot config', error)
    return integrationApiError('Internal server error', 500)
  }
}
