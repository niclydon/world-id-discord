import { routes } from './routes'
import { describe, expect, it } from 'vitest'

describe('routes.signIn', () => {
  it('points at the real sign-in route (with hyphen)', () => {
    // Regression: this used to return '/auth/signin', a route that does not
    // exist, so admin redirects landed on a 404 page.
    expect(routes.signIn()).toBe('/auth/sign-in')
  })

  it('carries the callback URL', () => {
    expect(routes.signIn({ callbackUrl: routes.admin() })).toBe(
      '/auth/sign-in?callbackUrl=/admin'
    )
  })
})
