const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string; detail?: string }
    const message = Array.isArray(payload.message) ? payload.message.join('；') : payload.message
    throw new Error(message || payload.detail || `请求失败 (${response.status})`)
  }
  return response.json() as Promise<T>
}

export const http = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(url: string, body: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}
