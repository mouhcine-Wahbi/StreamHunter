export type ApiErrorKind = "network" | "timeout" | "http" | "parse";

/** An error from StreamHunter's local API, with the HTTP-like status and code the UI explains. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isHttp(): boolean {
    return this.kind === "http";
  }

  /** Machine-readable code, e.g. "already_in_watchlist" or "platform_not_configured". */
  get code(): string | null {
    const err = (this.detail as { error?: { code?: unknown } } | null)?.error;
    return typeof err?.code === "string" ? err.code : null;
  }
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * The `/api/v1/...` interface the pages use. StreamHunter has no server: the only implementation
 * is `LocalApi` (src/local/local-api.ts), which answers inside the extension.
 */
export abstract class ApiClient {
  abstract request<T>(method: Method, path: string, body?: unknown): Promise<T>;

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {});
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}
