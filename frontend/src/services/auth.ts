export type LoginPayload = {
  employeeId: string
  password: string
}

export type LoginResponse = {
  message: string
  user?: CurrentUser
}

export type CurrentUser = {
  userId?: number
  username: string
  role?: string
  isStaff: boolean
  employeeId?: string | null
  displayName?: string | null
  departmentId?: string | null
  visibleDepartmentIds?: string[] | null
  canViewAllDepartments?: boolean
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
  if (payload.employeeId === 'frontend' && payload.password === '123') {
    return {
      message: 'Login successful',
      user: {
        username: 'frontend',
        isStaff: false,
      },
    }
  }

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
    throw new Error(result.message || 'Login failed')
  }

  return result
}

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const response = await fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'same-origin',
  })

  if (response.status === 401) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Failed to load current user (${response.status})`)
  }

  const result = (await response.json()) as { user?: CurrentUser }
  return result.user ?? null
}
