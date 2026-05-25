import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { login } from '../../services/auth'
import LoginForm from './LoginForm'

vi.mock('../../services/auth', () => ({
  login: vi.fn(),
}))

const loginMock = vi.mocked(login)

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
  })

  it('renders the login fields and submit button', () => {
    renderWithRouter()

    expect(screen.getByLabelText('員工編號')).toBeInTheDocument()
    expect(screen.getByLabelText('密碼')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登入系統' })).toBeInTheDocument()
  })

  it('submits employee id and password through the auth service', async () => {
    loginMock.mockResolvedValue({ message: '?餃??' })
    const user = userEvent.setup()
    renderWithRouter()

    await user.type(screen.getByLabelText('員工編號'), 'manager')
    await user.type(screen.getByLabelText('密碼'), 'demo123')
    await user.click(screen.getByRole('button', { name: '登入系統' }))

    expect(loginMock).toHaveBeenCalledWith({ employeeId: 'manager', password: 'demo123' })
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

    await user.type(screen.getByLabelText('員工編號'), 'manager')
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

    await user.type(screen.getByLabelText('員工編號'), 'manager')
    await user.type(screen.getByLabelText('密碼'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登入系統' }))

    expect(await screen.findByText('撣喳??航炊')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '登入系統' })).toBeEnabled())
  })
})
