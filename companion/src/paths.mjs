/** The companion's work folder and the rules for names inside it. Nothing is read or written outside it. */
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";

export function workDir(env = process.env) {
  return resolve(env.SH_COMPANION_HOME || join(homedir(), "Library", "Application Support", "StreamHunter"));
}

export const SUBDIRS = ["bin", "files", "jobs", "tmp", "logs"];

export function ensureLayout(dir) {
  for (const d of SUBDIRS) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A file name the extension may use: letters, digits, dot, dash, underscore; no path separators, no "..". */
export function isSafeName(name) {
  return typeof name === "string" && NAME.test(name) && !name.includes("..");
}

/** Resolves a safe name inside `base`, or throws. */
export function inside(base, name) {
  if (!isSafeName(name)) throw new Error("Invalid file name");
  const p = resolve(base, name);
  if (!p.startsWith(resolve(base) + sep)) throw new Error("Invalid file name");
  return p;
}
