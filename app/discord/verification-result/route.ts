import { verificationResultItemSchema } from '@/schemas/verification-result-item'
import { integrationApiError, integrationApiSuccess } from '@/server/integration-api/responses'
import { getIntegrationApiStore } from '@/server/integration-api/store'
import { verifyIntegrationApiRequest } from '@/server/integration-api/verify-request-auth'
import { NextRequest } from 'next/server'

/**
 * Self-hosted stand-in for the Discord integration API's verification
 * result endpoints. Records are keyed by (guild id, nullifier hash),
 * matching how the client fetches them.
 */
export const GET = async (request: NextRequest) => {
  if (!(await verifyIntegrationApiRequest(request))) {
    return integrationApiError('Unauthorized', 401)
  }

  const guildId = request.nextUrl.searchParams.get('guild_id')
  const nullifierHash = request.nextUrl.searchParams.get('nullifier_hash')

  if (!guildId || !nullifierHash) {
    return integrationApiError('Missing guild_id or nullifier_hash query parameter', 400)
  }

  try {
    const item = await getIntegrationApiStore().getVerificationResult(guildId, nullifierHash)

    if (!item) {
      return integrationApiError('Verification result not found', 404)
    }

    return integrationApiSuccess(item)
  } catch (error) {
    console.error('Error fetching verification result', error)
    return integrationApiError('Internal server error', 500)
  }
}

export const POST = async (request: NextRequest) => {
  if (!(await verifyIntegrationApiRequest(request))) {
    return integrationApiError('Unauthorized', 401)
  }

  const body = (await request.json().catch(() => null)) as unknown
  const parsed = verificationResultItemSchema.safeParse(body)

  if (!parsed.success) {
    return integrationApiError('Invalid verification result in request body', 400)
  }

  try {
    // Saving is an upsert: a repeated save for the same (guild id,
    // nullifier hash) key replaces the record and still succeeds, so
    // retries by the client are safe.
    await getIntegrationApiStore().saveVerificationResult(parsed.data)
    return integrationApiSuccess(parsed.data)
  } catch (error) {
    console.error('Error saving verification result', error)
    return integrationApiError('Internal server error', 500)
  }
}
