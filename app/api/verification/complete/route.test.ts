import { assignRoles } from '@/features/verification/server/assign-roles'
import { verifyInteractionsToken } from '@/features/verification/server/verify-interactions-jwt'
import { VerificationError } from '@/features/verification/types/verification-error'
import { fetchBotConfig } from '@/lib/discord-integration-api/fetch-bot-config'
import { fetchVerificationResult } from '@/lib/discord-integration-api/fetch-verification-result'
import { saveVerificationResult } from '@/lib/discord-integration-api/save-verification-result'
import { editInteractionMessage } from '@/lib/discord/edit-interaction-message'
import { ensureGuildRolesExist } from '@/lib/discord/ensure-guild-roles-exist'
import { getGuildData } from '@/lib/discord/get-guild-data'
import { userHasRoles } from '@/lib/discord/user-has-roles'
import { CredentialType } from '@/types/credential-type'
import { ExternalFetchError } from '@/utils/external-fetch-error'
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { APIGuild, APIRole } from 'discord-api-types/v10'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

vi.mock('@/features/verification/server/assign-roles', () => ({ assignRoles: vi.fn() }))
vi.mock('@/features/verification/server/verify-interactions-jwt', () => ({
  verifyInteractionsToken: vi.fn(),
}))
vi.mock('@/lib/discord-integration-api/fetch-bot-config', () => ({ fetchBotConfig: vi.fn() }))
vi.mock('@/lib/discord-integration-api/fetch-verification-result', () => ({
  fetchVerificationResult: vi.fn(),
}))
vi.mock('@/lib/discord-integration-api/save-verification-result', () => ({
  saveVerificationResult: vi.fn(),
}))
vi.mock('@/lib/discord/ensure-guild-roles-exist', () => ({ ensureGuildRolesExist: vi.fn() }))
vi.mock('@/lib/discord/get-guild-data', () => ({ getGuildData: vi.fn() }))
vi.mock('@/lib/discord/user-has-roles', () => ({ userHasRoles: vi.fn() }))
vi.mock('@/lib/discord/edit-interaction-message', () => ({ editInteractionMessage: vi.fn() }))
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))

const GUILD_ID = 'guild-123'
const USER_ID = 'user-456'
const NULLIFIER = `0x${'12'.repeat(32)}`
const V4_DECIMAL_NULLIFIER = BigInt(NULLIFIER).toString(10)
const TOKEN_FIELD = 'tok' + 'en'

const fetchMock = vi.fn()

const portalSuccess = () =>
  new Response(
    JSON.stringify({
      success: true,
      action: GUILD_ID,
      nullifier: NULLIFIER,
      protocol_version: '3.0',
      environment: 'production',
      results: [{ identifier: 'orb', success: true, nullifier: NULLIFIER }],
    }),
    { status: 200 }
  )

const makeBody = (resultOverrides: Record<string, unknown> = {}) => ({
  guildId: GUILD_ID,
  userId: USER_ID,
  [TOKEN_FIELD]: 'interaction-token-value',
  interactionsToken: 'interactions-token-value',
  result: {
    protocol_version: '3.0',
    nonce: 'nonce-1',
    environment: 'production',
    action: GUILD_ID,
    responses: [
      {
        identifier: 'orb',
        signal_hash: hashSignal(USER_ID),
        nullifier: NULLIFIER,
        proof: '0x1234',
        merkle_root: '0x5678',
      },
    ],
    ...resultOverrides,
  },
})

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost:3000/api/verification/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  vi.clearAllMocks()

  process.env.NEXT_PUBLIC_RP_ID = 'rp_test123'
  process.env.NEXTAUTH_URL = 'http://localhost:3000'
  process.env.NEXT_PUBLIC_WORLD_ID_ENVIRONMENT = 'production'
  delete process.env.NEXT_PUBLIC_APP_ID
  delete process.env.NEXT_PUBLIC_WORLD_ID_ENVIRONMENT

  fetchMock.mockReset()
  fetchMock.mockResolvedValue(portalSuccess())
  vi.stubGlobal('fetch', fetchMock)

  vi.mocked(verifyInteractionsToken).mockResolvedValue(undefined)
  vi.mocked(fetchVerificationResult).mockResolvedValue(null)
  vi.mocked(fetchBotConfig).mockResolvedValue({
    guild_id: GUILD_ID,
    enabled: true,
    orb: { enabled: true, roles: ['role-orb'] },
    device: { enabled: false, roles: [] },
  })
  vi.mocked(saveVerificationResult).mockResolvedValue(undefined)
  vi.mocked(ensureGuildRolesExist).mockResolvedValue(true)
  vi.mocked(getGuildData).mockResolvedValue({
    id: GUILD_ID,
    name: 'Test Guild',
    roles: [{ id: 'role-orb', name: 'Verified' }],
  } as unknown as APIGuild)
  vi.mocked(userHasRoles).mockResolvedValue(false)
  vi.mocked(assignRoles).mockResolvedValue([{ id: 'role-orb', name: 'Verified' } as APIRole])
  vi.mocked(editInteractionMessage).mockResolvedValue(undefined)
})

describe('POST /api/verification/complete', () => {
  it('grants roles and saves the record for a valid proof', async () => {
    const response = await post(makeBody())

    expect(response.status).toBe(200)

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe('/api/v4/verify/rp_test123')

    expect(saveVerificationResult).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD_ID, nullifierHash: NULLIFIER, userId: USER_ID })
    )
    expect(assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, rolesToAssign: ['role-orb'] })
    )
    expect(vi.mocked(saveVerificationResult).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(assignRoles).mock.invocationCallOrder[0]
    )
  })

  it('stores a v4 decimal nullifier canonically before granting a role', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: GUILD_ID,
          nullifier: V4_DECIMAL_NULLIFIER,
          environment: 'production',
          results: [
            { identifier: 'proof_of_human', success: true, nullifier: V4_DECIMAL_NULLIFIER },
          ],
        }),
        { status: 200 }
      )
    )

    const response = await post(
      makeBody({
        protocol_version: '4.0',
        responses: [
          {
            identifier: 'proof_of_human',
            signal_hash: hashSignal(USER_ID),
            nullifier: V4_DECIMAL_NULLIFIER,
            proof: ['1', '2', '3', '4', '5'],
            issuer_schema_id: 1,
            expires_at_min: 1,
          },
        ],
      })
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(saveVerificationResult).toHaveBeenCalledWith(
      expect.objectContaining({ nullifierHash: NULLIFIER, userId: USER_ID })
    )
    expect(assignRoles).toHaveBeenCalledOnce()
  })

  it('does not grant roles when saving a valid verification fails', async () => {
    vi.mocked(saveVerificationResult).mockRejectedValue(
      new Error('Integration API unavailable')
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await post(makeBody())

      expect(response.status).toBe(500)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(saveVerificationResult).toHaveBeenCalledWith(
        expect.objectContaining({
          guildId: GUILD_ID,
          nullifierHash: NULLIFIER,
          userId: USER_ID,
        })
      )
      expect(assignRoles).not.toHaveBeenCalled()
      expect(editInteractionMessage).toHaveBeenCalledOnce()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not grant roles for an invalid proof', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, code: 'invalid_proof', detail: 'Proof is invalid' }),
        { status: 400 }
      )
    )

    const response = await post(makeBody())

    expect(response.status).toBe(400)
    expect(assignRoles).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
  })

  it('does not save or grant roles when the Portal reports a different environment', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: GUILD_ID,
          nullifier: NULLIFIER,
          protocol_version: '3.0',
          environment: 'staging',
          results: [{ identifier: 'orb', success: true, nullifier: NULLIFIER }],
        })
      )
    )

    const response = await post(makeBody())

    expect(response.status).toBe(400)
    expect(saveVerificationResult).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant roles when another user wins the nullifier write race', async () => {
    vi.mocked(saveVerificationResult).mockRejectedValue(
      new ExternalFetchError('Failed to save verification result', {
        cause: { status: 409, data: { success: false, error: 'conflict' } },
      })
    )

    const response = await post(makeBody())

    expect(response.status).toBe(409)
    const payload = (await response.json()) as { errorCode?: string }
    expect(payload.errorCode).toBe(VerificationError.AlreadyVerified)
    expect(saveVerificationResult).toHaveBeenCalledOnce()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant roles when saving the verified proof fails', async () => {
    vi.mocked(saveVerificationResult).mockRejectedValue(new Error('storage unavailable'))

    const response = await post(makeBody())

    expect(response.status).toBe(500)
    expect(saveVerificationResult).toHaveBeenCalledOnce()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant roles for a proof minted for a different guild', async () => {
    const response = await post(makeBody({ action: 'another-guild' }))

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
  })

  it('rejects a missing or mismatched proof environment before verification', async () => {
    for (const environment of [undefined, 'sandbox']) {
      const response = await post(makeBody({ environment }))
      expect(response.status).toBe(400)
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
  })

  it('does not restore roles from a stored record with a mismatched proof environment', async () => {
    vi.mocked(fetchVerificationResult).mockResolvedValue({
      guild_id: GUILD_ID,
      nullifier_hash: NULLIFIER,
      signal_type: CredentialType.Orb,
      user_id: USER_ID,
      environment: 'production',
    })

    const response = await post(makeBody({ environment: 'staging' }))

    expect(response.status).toBe(400)
    expect(fetchVerificationResult).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant roles for a proof bound to a different user', async () => {
    const response = await post(
      makeBody({
        responses: [
          {
            identifier: 'orb',
            signal_hash: hashSignal('mallory'),
            nullifier: NULLIFIER,
            proof: '0x1234',
            merkle_root: '0x5678',
          },
        ],
      })
    )

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant roles when the nullifier is already bound to another user', async () => {
    vi.mocked(fetchVerificationResult).mockResolvedValue({
      guild_id: GUILD_ID,
      nullifier_hash: NULLIFIER,
      signal_type: CredentialType.Orb,
      user_id: 'someone-else',
      environment: 'production',
    })

    const response = await post(makeBody())

    expect(response.status).toBe(400)

    const payload = (await response.json()) as { errorCode?: string }
    expect(payload.errorCode).toBe(VerificationError.AlreadyVerified)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant or restore roles when the ownership lookup is unavailable', async () => {
    vi.mocked(fetchVerificationResult).mockRejectedValue(new Error('shared store unavailable'))

    const response = await post(makeBody())

    expect(response.status).toBe(500)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not restore roles from another World ID environment', async () => {
    vi.mocked(fetchVerificationResult).mockResolvedValue({
      guild_id: GUILD_ID,
      nullifier_hash: NULLIFIER,
      signal_type: CredentialType.Orb,
      user_id: USER_ID,
      environment: 'sandbox',
    })

    const response = await post(makeBody())

    expect(response.status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not restore roles from a legacy record with no environment', async () => {
    const legacyResult = {
      guild_id: GUILD_ID,
      nullifier_hash: NULLIFIER,
      signal_type: CredentialType.Orb,
      user_id: USER_ID,
    } as NonNullable<Awaited<ReturnType<typeof fetchVerificationResult>>>
    vi.mocked(fetchVerificationResult).mockResolvedValue(legacyResult)

    const response = await post(makeBody())

    expect(response.status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('restores roles for the recorded user without re-verifying the proof', async () => {
    vi.mocked(fetchVerificationResult).mockResolvedValue({
      guild_id: GUILD_ID,
      nullifier_hash: NULLIFIER,
      signal_type: CredentialType.Orb,
      user_id: USER_ID,
      environment: 'production',
    })

    const response = await post(makeBody())

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, rolesToAssign: ['role-orb'] })
    )
    expect(saveVerificationResult).not.toHaveBeenCalled()
  })

  it('does not grant roles for a staging proof on a production deployment', async () => {
    const response = await post(makeBody({ environment: 'staging' }))

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
  })

  it('does not restore roles for a recorded user from a staging proof', async () => {
    vi.mocked(fetchVerificationResult).mockResolvedValue({
      guild_id: GUILD_ID,
      nullifier_hash: NULLIFIER,
      signal_type: CredentialType.Orb,
      user_id: USER_ID,
      environment: 'production',
    })

    const response = await post(makeBody({ environment: 'staging' }))

    expect(response.status).toBe(400)
    expect(fetchVerificationResult).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('rejects an unknown environment value as a malformed body', async () => {
    const response = await post(makeBody({ environment: 'prod' }))

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('does not grant roles when the portal verified the proof in another environment', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: GUILD_ID,
          nullifier: NULLIFIER,
          protocol_version: '3.0',
          environment: 'staging',
          results: [{ identifier: 'orb', success: true, nullifier: NULLIFIER }],
        }),
        { status: 200 }
      )
    )

    const response = await post(makeBody())

    expect(response.status).toBe(400)
    expect(assignRoles).not.toHaveBeenCalled()
    expect(saveVerificationResult).not.toHaveBeenCalled()
  })

  it('rejects the request when the interactions token is invalid', async () => {
    vi.mocked(verifyInteractionsToken).mockRejectedValue(new Error('Invalid signature'))

    const response = await post(makeBody())

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })

  it('fails closed with a 500 when no RP id is configured', async () => {
    delete process.env.NEXT_PUBLIC_RP_ID

    const response = await post(makeBody())

    expect(response.status).toBe(500)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(assignRoles).not.toHaveBeenCalled()
  })
})
