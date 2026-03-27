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

function getCookie(name: string): string {
  const all = document.cookie
    .split('; ')
    .find((item) => item.startsWith(`${name}=`))

  if (!all) {
    return ''
  }

  return decodeURIComponent(all.split('=').slice(1).join('='))
}

async function ensureCsrfCookie(): Promise<void> {
  await fetch('/api/csrf/', {
    method: 'GET',
    credentials: 'same-origin',
  })
}

export async function login(payload: LoginPayload): Promise<LoginResponse> {
  await ensureCsrfCookie()
  const csrfToken = getCookie('csrftoken')

  const response = await fetch('/api/login/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfToken,
    },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  })

  const result = (await response.json()) as LoginResponse

  if (!response.ok) {
    throw new Error(result.message || '登入失敗')
  }

  return result
}
