import { assignGuildMemberRole } from '@/lib/discord/assign-guild-member-role'
import { PostHogClient } from '@/lib/posthog'
import { APIGuild, APIRole } from 'discord-api-types/v10'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assignRoles } from './assign-roles'

vi.mock('@/lib/discord/assign-guild-member-role', () => ({ assignGuildMemberRole: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ PostHogClient: vi.fn() }))

const role = { id: 'role-orb', name: 'Verified' } as APIRole
const guild = { id: 'guild-123', roles: [role] } as APIGuild
const input = { guild, userId: 'user-456', rolesToAssign: [role.id] }

describe('assignRoles', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('NODE_ENV', 'production')
    vi.mocked(assignGuildMemberRole).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns granted roles when telemetry shutdown fails', async () => {
    const telemetryFailure = new Error('telemetry unavailable')
    const shutdown = vi.fn().mockRejectedValue(telemetryFailure)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(PostHogClient).mockReturnValue({
      capture: async params => ({ success: true, params }),
      flush: async data => data,
      shutdown,
    })

    await expect(assignRoles(input)).resolves.toEqual([role])
    expect(assignGuildMemberRole).toHaveBeenCalledWith(guild.id, input.userId, role.id)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(logError).toHaveBeenCalledWith(
      'Error reporting verification analytics',
      telemetryFailure
    )
  })

  it('still reports a failed role grant as a failure', async () => {
    const grantFailure = new Error('Discord refused the role')
    vi.mocked(assignGuildMemberRole).mockRejectedValue(grantFailure)

    await expect(assignRoles(input)).rejects.toBe(grantFailure)
    expect(PostHogClient).not.toHaveBeenCalled()
  })
})
