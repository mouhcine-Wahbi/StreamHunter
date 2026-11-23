/**
 * The file channel: video files are too large for native messaging (1 MB per message from the
 * host), so the extension moves them over HTTP on 127.0.0.1 only. Every request needs the per-launch
 * token (handed over through native messaging) and this extension's Origin; the Host header must
 * be the loopback address (no DNS rebinding). Files live only in the work folder's `files/`.
 */
import { createServer } from "node:http";
import { createReadStream, createWriteStream, renameSync, rmSync, statSync, statfsSync, readdirSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { inside, isSafeName } from "./paths.mjs";

export const MAX_UPLOAD = 8 * 1024 ** 3;
/** Uploads are refused when they would leave less than this free on the disk. */
export const DISK_RESERVE = 2 * 1024 ** 3;

export function freeBytes(dir) {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function startFileServer({ dir, origins, log = () => undefined, maxUpload = MAX_UPLOAD, reserve = DISK_RESERVE }) {
  const token = randomBytes(32).toString("hex");
  const files = join(dir, "files");
  const tokenBuf = Buffer.from(token);

  const sameToken = (t) => typeof t === "string" && t.length === token.length && timingSafeEqual(Buffer.from(t), tokenBuf);

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = typeof origin === "string" && origins.includes(origin);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", ...(allowed ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) });
      res.end(JSON.stringify(body));
    };
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}`) return send(421, { error: "Wrong host" });
    if (!allowed) return send(403, { error: "Origin not allowed" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, PUT, DELETE",
        "access-control-allow-headers": "x-sh-token, content-type",
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600",
        vary: "Origin",
      });
      return res.end();
    }
    if (!sameToken(req.headers["x-sh-token"])) return send(401, { error: "Missing or wrong token" });

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/files" && req.method === "GET") {
      const list = readdirSync(files).filter((n) => isSafeName(n)).map((n) => ({ name: n, size: statSync(join(files, n)).size }));
      return send(200, { files: list });
    }
    const m = /^\/v1\/files\/([^/]+)$/.exec(url.pathname);
    if (!m) return send(404, { error: "Not found" });
    let name;
    try {
      name = decodeURIComponent(m[1]);
      inside(files, name);
    } catch {
      return send(400, { error: "Invalid file name" });
    }
    const path = inside(files, name);
    try {
      if (req.method === "PUT") {
        const length = Number(req.headers["content-length"]);
        if (!Number.isFinite(length) || length < 0) return send(411, { error: "Content-Length required" });
        if (length > maxUpload) return send(413, { error: `File too large (limit ${maxUpload} bytes)` });
        if (freeBytes(dir) - length < reserve) return send(507, { error: "Not enough free disk space" });
        const part = `${path}.part-${randomBytes(4).toString("hex")}`;
        const hash = createHash("sha256");
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          hash.update(c);
          if (size > length) req.destroy(new Error("Body longer than Content-Length"));
        });
        try {
          await pipeline(req, createWriteStream(part));
        } catch (e) {
          rmSync(part, { force: true });
          throw e;
        }
        if (size !== length) {
          rmSync(part, { force: true });
          return send(400, { error: "Upload incomplete" });
        }
        renameSync(part, path);
        log("file_put", { name, size });
        return send(200, { name, size, sha256: hash.digest("hex") });
      }
      if (req.method === "GET") {
        const st = statSync(path, { throwIfNoEntry: false });
        if (!st?.isFile()) return send(404, { error: "No such file" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "access-control-allow-origin": origin, vary: "Origin" });
        await pipeline(createReadStream(path), res);
        return;
      }
      if (req.method === "DELETE") {
        rmSync(path, { force: true });
        return send(200, { deleted: name });
      }
      return send(405, { error: "Method not allowed" });
    } catch (e) {
      log("file_error", { name, error: e.message });
      if (!res.headersSent) send(500, { error: "File operation failed" });
      else res.destroy();
    }
  });
  server.requestTimeout = 0; // large uploads
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, token }));
  });
}
