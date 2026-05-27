import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { login, requestPasswordReset } from '../../services/auth'
import LoginForm from './LoginForm'

vi.mock('../../services/auth', () => ({
  login: vi.fn(),
  requestPasswordReset: vi.fn(),
}))

const loginMock = vi.mocked(login)
const requestPasswordResetMock = vi.mocked(requestPasswordReset)

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <LoginForm />
    </MemoryRouter>,
  )
}

describe('LoginForm', () => {
  beforeEach(() => {
    loginMock.mockReset()
    requestPasswordResetMock.mockReset()
    const storage = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
        removeItem: vi.fn((key: string) => storage.delete(key)),
        clear: vi.fn(() => storage.clear()),
      },
    })
    window.localStorage.clear()
  })

  it('renders the login fields and submit button', () => {
    renderWithRouter()

    expect(screen.getByLabelText('登入帳號')).toBeInTheDocument()
    expect(screen.getByLabelText('密碼')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登入系統' })).toBeInTheDocument()
  })

  it('submits employee id and password through the auth service', async () => {
    loginMock.mockResolvedValue({ message: '?餃??' })
    const user = userEvent.setup()
    renderWithRouter()

    await user.type(screen.getByLabelText('登入帳號'), 'manager')
    await user.type(screen.getByLabelText('密碼'), 'demo123')
    await user.click(screen.getByRole('button', { name: '登入系統' }))

    expect(loginMock).toHaveBeenCalledWith({ employeeId: 'manager', password: 'demo123', rememberMe: false })
    expect(await screen.findByText('?餃??')).toBeInTheDocument()
  })

  it('shows the loading state while login is pending', async () => {
    let resolveLogin: (value: { message: string }) => void = () => undefined
    loginMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve
      }),
    )
    const user = userEvent.setup()
    renderWithRouter()

    await user.type(screen.getByLabelText('登入帳號'), 'manager')
    await user.type(screen.getByLabelText('密碼'), 'demo123')
    await user.click(screen.getByRole('button', { name: '登入系統' }))

    expect(screen.getByRole('button', { name: '登入中...' })).toBeDisabled()

    resolveLogin({ message: '?餃??' })
    expect(await screen.findByText('?餃??')).toBeInTheDocument()
  })

  it('shows an error alert when login fails', async () => {
    loginMock.mockRejectedValue(new Error('撣喳??航炊'))
    const user = userEvent.setup()
    renderWithRouter()

    await user.type(screen.getByLabelText('登入帳號'), 'manager')
    await user.type(screen.getByLabelText('密碼'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登入系統' }))

    expect(await screen.findByText('撣喳??航炊')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '登入系統' })).toBeEnabled())
  })

  it('stores the login account when remember me is selected', async () => {
    loginMock.mockResolvedValue({ message: '?餃??' })
    const user = userEvent.setup()
    renderWithRouter()

    await user.type(screen.getByLabelText('登入帳號'), 'manager')
    await user.type(screen.getByLabelText('密碼'), 'demo123')
    await user.click(screen.getByLabelText('記住我'))
    await user.click(screen.getByRole('button', { name: '登入系統' }))

    await waitFor(() => expect(window.localStorage.getItem('attendance.rememberedLogin')).toBe('manager'))
    expect(loginMock).toHaveBeenCalledWith({ employeeId: 'manager', password: 'demo123', rememberMe: true })
  })

  it('requests a one-time password reset link', async () => {
    requestPasswordResetMock.mockResolvedValue({ message: '已產生一次性重設密碼連結，30 分鐘內有效。', resetLink: '/reset-password?token=abc' })
    const user = userEvent.setup()
    renderWithRouter()

    await user.click(screen.getByRole('button', { name: '忘記密碼？' }))
    await user.type(screen.getAllByLabelText('登入帳號')[1], 'employee')
    await user.type(screen.getByLabelText('Email'), 'employee@demo.local')
    await user.click(screen.getByRole('button', { name: '產生一次性更改密碼連結' }))

    expect(await screen.findByText('/reset-password?token=abc')).toBeInTheDocument()
    expect(requestPasswordResetMock).toHaveBeenCalledWith('employee', 'employee@demo.local')
  })
})
