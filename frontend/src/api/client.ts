export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }

  /** The session is gone or was never established — the shell redirects to login. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export interface ApiInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Every backend call goes through here. Cookies are the only auth mechanism
 * (httpOnly session cookie, spec §6.1), so credentials are always included.
 */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const hasBody = init.body !== undefined;
  if (hasBody) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    let message = response.statusText || `request failed with ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // non-JSON error body (nginx 502 pages, for example) — keep the status text
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
