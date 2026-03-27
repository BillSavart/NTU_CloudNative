export type LoginPayload = {
  employeeId: string
  password: string
}

export type LoginResponse = {
  message: string
  user?: {
    username: string
    isStaff: boolean
  }
}

export async function login(payload: LoginPayload): Promise<LoginResponse> {
  const response = await fetch('/api/login/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const result = (await response.json()) as LoginResponse

  if (!response.ok) {
    throw new Error(result.message || '登入失敗')
  }

  return result
}
