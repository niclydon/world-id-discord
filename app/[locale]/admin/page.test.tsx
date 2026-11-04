import { userIsGuildAdmin } from '@/lib/discord/user-is-guild-admin'
import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/server/auth-options', () => ({ authOptions: {} }))
vi.mock('@/lib/discord/user-is-guild-admin', () => ({ userIsGuildAdmin: vi.fn() }))
vi.mock('@/lib/discord/fetch-available-guild-roles', () => ({
  fetchAvailableGuildRoles: vi.fn(),
}))
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}))

const { default: Admin } = await import('./page')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id: 'user-1' },
    guild: { id: 'guild-1' },
  } as Awaited<ReturnType<typeof getServerSession>>)
})

afterEach(() => vi.restoreAllMocks())

describe('admin access', () => {
  it('shows a stable denied state when the signed-in user is not an admin', async () => {
    vi.mocked(userIsGuildAdmin).mockResolvedValue(false)

    const markup = renderToStaticMarkup(await Admin())

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Discord_Integration_Admin_Access_Denied_Title')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('shows a stable error state when the Discord permission check fails', async () => {
    vi.mocked(userIsGuildAdmin).mockRejectedValue(new Error('Discord unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const markup = renderToStaticMarkup(await Admin())

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Discord_Integration_Admin_Check_Unavailable_Title')
    expect(redirect).not.toHaveBeenCalled()
  })
})
