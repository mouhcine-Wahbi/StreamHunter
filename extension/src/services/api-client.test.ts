import { ApiClient, ApiError } from "./api-client";
import { json, mockFetch } from "@/test/http";

describe("ApiClient", () => {
  it("sends JSON with bearer token and parses the response", async () => {
    const fetch = mockFetch(() => json({ status: "ok", version: "0.1.0" }));
    const client = new ApiClient({ baseUrl: "http://localhost:8000/", getToken: async () => "tok" });
    await expect(client.health()).resolves.toEqual({ status: "ok", version: "0.1.0" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/v1/health");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init!.credentials).toBe("omit");
  });

  it("raises http errors with the backend message", async () => {
    mockFetch(() => json({ error: { code: "not_found", message: "Streamer not found" } }, 404));
    const client = new ApiClient({ baseUrl: "http://localhost:8000" });
    const err = await client.get("/api/v1/streamers/9").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: "http", status: 404, message: "Streamer not found" });
  });

  it("supports FastAPI's default detail field", async () => {
    mockFetch(() => json({ detail: "Not authenticated" }, 401));
    const err = await new ApiClient({ baseUrl: "http://x.test" }).get("/a").catch((e) => e);
    expect(err).toMatchObject({ kind: "http", status: 401, message: "Not authenticated" });
  });

  it("maps fetch failures to network errors", async () => {
    mockFetch(() => null);
    const err = await new ApiClient({ baseUrl: "http://localhost:8000" }).health().catch((e) => e);
    expect(err).toMatchObject({ kind: "network" });
  });

  it("times out slow requests", async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const err = await new ApiClient({ baseUrl: "http://localhost:8000", timeoutMs: 20 }).health().catch((e) => e);
    expect(err).toMatchObject({ kind: "timeout" });
  });

  it("flags invalid JSON on success responses", async () => {
    mockFetch(() => new Response("<html>", { status: 200 }));
    const err = await new ApiClient({ baseUrl: "http://localhost:8000" }).health().catch((e) => e);
    expect(err).toMatchObject({ kind: "parse" });
  });
});
