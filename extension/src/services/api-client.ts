export type ApiErrorKind = "network" | "timeout" | "http" | "parse";

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

  /** Backend reachable but answered with an error. */
  get isHttp(): boolean {
    return this.kind === "http";
  }

  /** Machine-readable code from the backend's error envelope, e.g. "already_in_watchlist". */
  get code(): string | null {
    const err = (this.detail as { error?: { code?: unknown } } | null)?.error;
    return typeof err?.code === "string" ? err.code : null;
  }
}

export interface HealthResponse {
  status: string;
  version?: string;
  [key: string]: unknown;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => Promise<string | null>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Minimal typed HTTP client for the StreamHunter backend. Works in both the
 * service worker and extension pages (no DOM dependencies).
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly getToken: () => Promise<string | null>;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.getToken = opts.getToken ?? (async () => null);
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    const token = await this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
      });
    } catch (err) {
      if (controller.signal.aborted) throw new ApiError("timeout", `Request timed out after ${this.timeoutMs} ms`);
      throw new ApiError("network", err instanceof Error ? err.message : "Network error");
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError("parse", "Backend returned invalid JSON", res.status);
        data = text;
      }
    }

    if (!res.ok) {
      throw new ApiError("http", extractMessage(data) ?? `HTTP ${res.status}`, res.status, data);
    }
    return data as T;
  }

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

  /** Multipart upload (the browser sets the boundary header). No timeout: files can be large. */
  upload<T>(path: string, form: FormData): Promise<T> {
    return new ApiClient({ baseUrl: this.baseUrl, getToken: this.getToken, fetchImpl: this.fetchImpl, timeoutMs: 6 * 60 * 60_000 }).request<T>(
      "POST",
      path,
      form,
    );
  }

  /** Authenticated binary download. */
  async blob(path: string): Promise<Blob> {
    const token = await this.getToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "omit",
    });
    if (!res.ok) throw new ApiError("http", `Download failed (HTTP ${res.status})`, res.status);
    return res.blob();
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/api/v1/health");
  }
}

function extractMessage(data: unknown): string | null {
  if (typeof data === "string") return data.slice(0, 300);
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof obj.detail === "string") return obj.detail;
  if (typeof obj.message === "string") return obj.message;
  return null;
}
