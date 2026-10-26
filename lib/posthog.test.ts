import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captured: unknown[] = []
let constructed = 0

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor() {
      constructed += 1
    }
    capture(params: unknown) {
      captured.push(params)
    }
    async flush() {}
    async shutdown() {}
  },
}))

import { PostHogClient } from './posthog'

describe('PostHogClient', () => {
  beforeEach(() => {
    captured.length = 0
    constructed = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not throw when PostHog is not configured', () => {
    vi.stubEnv('POSTHOG_API_KEY', '')
    vi.stubEnv('POSTHOG_HOST', '')

    expect(() => PostHogClient()).not.toThrow()
    expect(constructed).toBe(0)
  })

  it('capture is a silent no-op when PostHog is not configured', async () => {
    vi.stubEnv('POSTHOG_API_KEY', '')
    vi.stubEnv('POSTHOG_HOST', '')

    const client = PostHogClient()
    const result = await client.capture({ event: 'test event', distinctId: 'user-1' })

    expect(result.success).toBe(true)
    expect(captured).toHaveLength(0)
    await expect(client.shutdown()).resolves.toBeUndefined()
  })

  it('captures through the real client when PostHog is configured', async () => {
    vi.stubEnv('POSTHOG_API_KEY', 'test-api-key')
    vi.stubEnv('POSTHOG_HOST', 'https://posthog.example')

    const client = PostHogClient()
    const result = await client.capture({ event: 'test event', distinctId: 'user-1' })

    expect(constructed).toBe(1)
    expect(result.success).toBe(true)
    expect(captured).toHaveLength(1)
    await client.shutdown()
  })
})
