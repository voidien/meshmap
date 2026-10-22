/** Thin fetch wrapper for the meshmap server. Errors carry the server's message. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, extra?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...extra,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const o = (json ?? {}) as { error?: string; details?: Record<string, unknown> };
    throw new ApiError(res.status, o.error ?? `Request failed (${res.status})`, o.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown, extra?: RequestInit) => request<T>("PUT", path, body, extra),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
}

export interface SessionInfo {
  setupRequired: boolean;
  user: SessionUser | null;
  passkeyCount: number;
}
