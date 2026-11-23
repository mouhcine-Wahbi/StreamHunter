/**
 * Chrome native messaging framing: each message is a 32-bit length (native byte order; little-endian
 * on every Mac Chrome supports) followed by that many bytes of UTF-8 JSON. Chrome rejects messages
 * from the host larger than 1 MB; messages to the host can be up to 64 MiB.
 */
export const MAX_TO_CHROME = 1024 * 1024;
export const MAX_FROM_CHROME = 64 * 1024 * 1024;

export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_TO_CHROME) throw new Error(`Message too large for Chrome (${body.length} bytes; the limit is 1 MB)`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Incremental decoder: feed chunks as they arrive, get whole messages back. */
export function createDecoder(onMessage, onError) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_FROM_CHROME) {
        buf = Buffer.alloc(0);
        onError(new Error(`Incoming message too large (${len} bytes)`));
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        onError(new Error("Incoming message is not valid JSON"));
        continue;
      }
      onMessage(msg);
    }
  };
}
