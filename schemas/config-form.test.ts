import { describe, expect, it } from 'vitest'
import { craftConfigFormSchema } from './config-form'

// The schema only uses the translator for the roles error message; echo the
// key back so assertions can match on it.
const t = ((key: string) => key) as never

const schema = craftConfigFormSchema(t)

const role = { label: 'Verified Human', value: '1564184843628060702' }

describe('craftConfigFormSchema', () => {
  it('accepts the single-level setup: orb enabled with a role, device disabled with none', () => {
    // The operator's exact configuration when Save reported a generic error.
    const result = schema.safeParse({
      botEnabled: true,
      deviceEnabled: false,
      deviceRoles: [],
      orbEnabled: true,
      orbRoles: [role],
    })

    expect(result.success).toBe(true)
  })

  it('accepts both levels disabled with no roles selected', () => {
    const result = schema.safeParse({
      botEnabled: false,
      deviceEnabled: false,
      deviceRoles: [],
      orbEnabled: false,
      orbRoles: [],
    })

    expect(result.success).toBe(true)
  })

  it('rejects an enabled device level with no roles', () => {
    const result = schema.safeParse({
      botEnabled: true,
      deviceEnabled: true,
      deviceRoles: [],
      orbEnabled: true,
      orbRoles: [role],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path)).toContainEqual(['deviceRoles'])
    }
  })

  it('rejects an enabled orb level with no roles', () => {
    const result = schema.safeParse({
      botEnabled: true,
      deviceEnabled: false,
      deviceRoles: [],
      orbEnabled: true,
      orbRoles: [],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path)).toContainEqual(['orbRoles'])
    }
  })
})
