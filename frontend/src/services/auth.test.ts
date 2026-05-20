import { beforeEach, describe, expect, it, vi } from 'vitest'

import { login } from './auth'

describe('auth service', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.cookie = 'csrftoken=; Max-Age=0'
  })

  it('fetches csrf before posting login credentials', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        document.cookie = 'csrftoken=test-token'
        return new Response(JSON.stringify({ csrfToken: 'test-token' }), { status: 200 })
      })
      .mockImplementationOnce(async () => (
        new Response(JSON.stringify({ message: '登入成功' }), { status: 200 })
      ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(login({ employeeId: 'manager', password: 'demo123' })).resolves.toEqual({
      message: '登入成功',
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
      .mockImplementationOnce(async () => {
        document.cookie = 'csrftoken=test-token'
        return new Response(JSON.stringify({ csrfToken: 'test-token' }), { status: 200 })
      })
      .mockImplementationOnce(async () => (
        new Response(JSON.stringify({ message: '登入失敗' }), { status: 401 })
      ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(login({ employeeId: 'manager', password: 'wrong' })).rejects.toThrow('登入失敗')
  })
})
