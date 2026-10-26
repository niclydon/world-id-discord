import { getAppUrl } from '@/utils/get-app-url'
import { jwtVerify } from 'jose'

/**
 * Verifies the authorization header the integration API client sends.
 *
 * The client (lib/discord-integration-api/generate-authorization-header)
 * signs a short-lived HS256 JWT with DISCORD_INTEGRATION_API_SIGN_SECRET,
 * with subject 'discord-integration', the app URL as issuer, and
 * DISCORD_INTEGRATION_API_URL as audience. This checks a presented token
 * against exactly those expectations; anything else is rejected.
 */
export const verifyIntegrationApiRequest = async (request: Request): Promise<boolean> => {
  const secret = process.env.DISCORD_INTEGRATION_API_SIGN_SECRET
  const audience = process.env.DISCORD_INTEGRATION_API_URL

  if (!secret || !audience) {
    console.error('Discord integration API environment is not configured')
    return false
  }

  const authorization = request.headers.get('authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return false
  }

  const appUrl = getAppUrl().toString()
  const issuer = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl

  try {
    await jwtVerify(authorization.slice('Bearer '.length), new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      audience,
      issuer,
      subject: 'discord-integration',
    })

    return true
  } catch {
    return false
  }
}
