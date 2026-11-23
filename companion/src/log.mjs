/** Logs go to a file: stdout belongs to Chrome's native messaging channel. */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX = 5 * 1024 * 1024;

export function createLog(dir) {
  const file = join(dir, "logs", "companion.log");
  return (event, data = {}) => {
    try {
      if (statSync(file, { throwIfNoEntry: false })?.size > MAX) renameSync(file, file + ".1");
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n");
    } catch {
      // Logging must never break the companion.
    }
  };
}
