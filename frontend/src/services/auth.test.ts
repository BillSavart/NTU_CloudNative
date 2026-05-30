import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  confirmPasswordReset,
  fetchCurrentUser,
  login,
  logout,
  requestPasswordReset,
} from './auth'

describe('auth service', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetches csrf before posting login credentials', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'test-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'login ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(login({ employeeId: 'manager', password: 'demo123' })).resolves.toEqual({
      message: 'login ok',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/csrf/', {
      method: 'GET',
      credentials: 'same-origin',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/login/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': 'test-token',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ employeeId: 'manager', password: 'demo123' }),
    })
  })

  it('throws the response message when login fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'test-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'bad login' }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(login({ employeeId: 'manager', password: 'wrong' })).rejects.toThrow('bad login')
  })

  it('requests a password reset with csrf protection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'reset-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'sent', resetLink: 'http://reset' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestPasswordReset('rd_1_manager', 'rd1@example.com')).resolves.toEqual({
      message: 'sent',
      resetLink: 'http://reset',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/password-reset/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': 'reset-token',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ loginId: 'rd_1_manager', email: 'rd1@example.com' }),
    })
  })

  it('uses fallback errors for failed password reset requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestPasswordReset('missing', 'missing@example.com')).rejects.toThrow('重設密碼連結產生失敗')
  })

  it('confirms password reset and falls back to default success messages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'confirm-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(confirmPasswordReset('token-1', 'new-password')).resolves.toEqual({ message: '密碼已更新' })

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/password-reset/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': 'confirm-token',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ token: 'token-1', password: 'new-password' }),
    })
  })

  it('prefers detail messages when password reset confirmation fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'confirm-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'expired token' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(confirmPasswordReset('expired', 'new-password')).rejects.toThrow('expired token')
  })

  it('returns null for anonymous current-user checks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 401 })))

    await expect(fetchCurrentUser()).resolves.toBeNull()
  })

  it('loads the current user when authenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      user: { username: 'rd_1_manager', isStaff: true },
    }), { status: 200 })))

    await expect(fetchCurrentUser()).resolves.toEqual({ username: 'rd_1_manager', isStaff: true })
  })

  it('throws status details for current-user and logout failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 503 })))
    await expect(fetchCurrentUser()).rejects.toThrow('Failed to load current user (503)')

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'logout-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(logout()).rejects.toThrow('Logout failed (500)')
  })

  it('posts logout with csrf protection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'logout-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(logout()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/logout', {
      method: 'POST',
      headers: {
        'X-CSRFToken': 'logout-token',
      },
      credentials: 'same-origin',
    })
  })
})
