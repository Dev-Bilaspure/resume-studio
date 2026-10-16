import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolves a user-supplied relative path inside `base`, refusing anything that escapes it
 * (`../`, absolute paths, NUL bytes). Every file path that comes from a request goes through here.
 */
export function safeJoin(base: string, rel: string): string {
  if (!rel || rel.includes("\0") || isAbsolute(rel)) throw new HttpError(400, "Invalid path");
  const full = normalize(join(base, rel));
  const r = relative(base, full);
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new HttpError(400, "Path is outside the resume");
  return full;
}

/** Forward-slash relative path, for the API and the UI. */
export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Crash-safe write: temp file in the same directory, fsync, then rename over the target.
 * A reader (or the compiler) sees either the old file or the new one, never a half-written file.
 */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Turns a display name into a folder name: "Acme — SRE (2026)" → "acme-sre-2026". */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "resume"
  );
}

/** Editor temp/backup files and OS clutter: never compiled, listed, or snapshotted. */
export function isJunk(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name.endsWith("~") ||
    name.endsWith(".swp") ||
    name.endsWith(".swx") ||
    name.endsWith(".tmp") ||
    name.startsWith(".#") ||
    name.startsWith("#")
  );
}
