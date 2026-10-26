import { EventMessage, PostHog } from 'posthog-node'

type CaptureResult = { success: true; params: EventMessage } | { success: false; error: unknown }

type PostHogClientShape = {
  capture: (params: EventMessage) => Promise<CaptureResult>
  flush: <T>(data?: T) => Promise<T | undefined>
  shutdown: () => Promise<void>
}

/**
 * Analytics is strictly optional. When the PostHog environment is not
 * configured, the returned client's capture/flush/shutdown are silent
 * no-ops: a missing telemetry setup must never fail the flow that reports
 * through it (verification role assignment did exactly that in production:
 * the role landed, then this throw painted a failure page over it).
 */
export const PostHogClient = (): PostHogClientShape => {
  if (!process.env.POSTHOG_API_KEY || !process.env.POSTHOG_HOST) {
    return {
      capture: async params => ({ success: true, params }),
      flush: async data => data,
      shutdown: async () => {},
    }
  }

  const client = new PostHog(process.env.POSTHOG_API_KEY, {
    host: process.env.POSTHOG_HOST,
    flushAt: 1,
  })

  const flush = async <T>(data?: T) => {
    await client?.flush()
    return data
  }

  const capture = async (params: EventMessage): Promise<CaptureResult> => {
    try {
      client?.capture(params)
      await flush()
      return { success: true, params }
    } catch (error) {
      return { success: false, error }
    }
  }

  const shutdown = async () => {
    await client?.shutdown()
  }

  return {
    capture,
    flush,
    shutdown,
  }
}
