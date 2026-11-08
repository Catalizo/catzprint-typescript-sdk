import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LocalEndpoint } from "./types.js";

/**
 * What the SDK keeps per device: the local token and the last endpoint list
 * from the cloud, so a hub that restarts while the internet is down can still
 * find and trust its stations.
 */
export interface StoredToken {
  /** The local token (`czl1…`); empty when only endpoints are stored. */
  token?: string;
  token_id?: string;
  /** ISO 8601. */
  expires_at?: string;
  stations?: LocalEndpoint[];
  /** ISO 8601: when the endpoint list was fetched. */
  stations_updated_at?: string;
  /** ISO 8601: when a station's token_expired last caused a re-mint (at most once per 10 minutes). */
  last_remint_at?: string;
  /** ISO 8601: when the token was minted (for the refresh threshold). */
  issued_at?: string;
}

/**
 * The token store file or its directory isn't owned by the current user or is
 * writable by group/others (POSIX). The SDK refuses to use it.
 */
export class InsecureTokenStoreError extends Error {
  readonly code = "insecure_token_store";
  readonly path: string;
  constructor(path: string, why: string) {
    super(`Refusing to use the token store ${path}: ${why}.`);
    this.name = "InsecureTokenStoreError";
    this.path = path;
  }
}

/** POSIX: refuse an existing path not owned by us or writable by group/others. */
async function checkPerms(path: string): Promise<void> {
  if (process.platform === "win32" || typeof process.geteuid !== "function") return;
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.uid !== process.geteuid()) throw new InsecureTokenStoreError(path, `it is owned by another user (uid ${st.uid})`);
  if ((st.mode & 0o022) !== 0) throw new InsecureTokenStoreError(path, `it is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
}

/** Persists local tokens. `load` resolves undefined when nothing is stored. */
export interface TokenStore {
  load(key: string): Promise<StoredToken | undefined>;
  save(key: string, token: StoredToken): Promise<void>;
}

const clone = (t: StoredToken | undefined): StoredToken | undefined =>
  t === undefined ? undefined : { ...t, stations: t.stations ? [...t.stations] : undefined };

/** Keeps tokens in memory (the default): minted again after a restart. */
export class MemoryTokenStore implements TokenStore {
  readonly #m = new Map<string, StoredToken>();
  async load(key: string): Promise<StoredToken | undefined> {
    return clone(this.#m.get(key));
  }
  async save(key: string, token: StoredToken): Promise<void> {
    this.#m.set(key, clone(token)!);
  }
}

/**
 * Keeps tokens in a JSON file readable only by the current user (mode 0600,
 * directory 0700). Every save writes a temporary file next to it and renames
 * it into place, so the file is never half-written.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async #readAll(): Promise<Record<string, StoredToken>> {
    await checkPerms(dirname(this.path));
    await checkPerms(this.path);
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    if (!text.trim()) return {};
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Token store ${this.path} is corrupt.`);
    return data as Record<string, StoredToken>;
  }

  async load(key: string): Promise<StoredToken | undefined> {
    await this.#queue.catch(() => {});
    return (await this.#readAll())[key];
  }

  save(key: string, token: StoredToken): Promise<void> {
    const run = this.#queue.catch(() => {}).then(async () => {
      let all: Record<string, StoredToken>;
      try {
        all = await this.#readAll();
      } catch (err) {
        if (err instanceof InsecureTokenStoreError) throw err;
        all = {}; // a corrupt file is replaced rather than blocking printing
      }
      all[key] = token;
      await writeFileAtomic(this.path, JSON.stringify(all, null, 2));
    });
    this.#queue = run;
    return run;
  }
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkPerms(dir);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
