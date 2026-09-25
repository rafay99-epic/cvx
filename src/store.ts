/**
 * store — the data layer. Vault I/O, the Convex global-config swap, token
 * verification, path resolution, and first-run state. No presentation here
 * (colors/printing live in ui.ts).
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
  type Backend,
  detectBackend,
  storeToken,
  loadToken,
  deleteToken,
} from "./keychain";
import { decryptToken, encryptToken } from "./vault";

// Placeholder for local/dev runs; the release workflow stamps the real
// 0.<commit-count> version into this line before compiling (see release.yml).
export const VERSION = "0.0.0-dev";

// --- Paths & constants ------------------------------------------------------

export { HOME, VAULT } from "./paths"; // resolved in ONE place (CVX_HOME sandbox)
import { HOME, VAULT } from "./paths";
const ACCOUNTS_FILE = join(VAULT, "accounts.json");
const LINKS_FILE = join(VAULT, "links.json");
const CONFIG_FILE = join(VAULT, "config.json");
const ACTIVE_FILE = join(VAULT, "active");
const WELCOME_MARKER = join(VAULT, ".welcomed");
const CONVEX_CONFIG = join(HOME, ".convex", "config.json");
const API_TEAMS = "https://api.convex.dev/api/teams";
const CLIENT = `convex-switch/${VERSION}`;

// Vault schema version. Bump when the on-disk format changes; a legacy vault
// (no schemaVersion, or a lower one) triggers the one-time migration prompt.
export const SCHEMA = 2;

// --- Types ------------------------------------------------------------------

export type Team = { slug: string; name: string };
/**
 * An account's token lives in exactly one place: inline (`token`, the default
 * file vault), the OS keychain (`keychain: true`), a DPAPI blob (`enc`, on
 * Windows), or a passphrase-encrypted blob (`pw`, see vault.ts). Resolve with
 * tokenOf(); never read `.token` directly.
 */
export type Account = {
  token?: string;
  keychain?: boolean;
  enc?: string;
  pw?: string;
  teams: Team[];
  addedAt: string;
  verifiedAt?: string; // last successful token verification against Convex
  // Human label only — Convex's profile API rejects CLI tokens
  // ("WorkOSSessionRequired"), so the email can't be fetched; we ask the user.
  email?: string;
};
export type Accounts = Record<string, Account>;
/** The fields that say where a token lives; everything else on Account is metadata. */
type SecretField = "token" | "keychain" | "enc" | "pw";
export type TokenRecord = Pick<Account, SecretField>;
export type AccountMeta = Omit<Account, SecretField>;
export type Links = Record<string, string>; // absolute project path -> account name
export type Config = { storage?: Backend; schemaVersion?: number; disabled?: boolean };

// --- Vault I/O (dir 700, files 600) -----------------------------------------

export function ensureVault() {
  // A brand-new vault (no accounts file yet) is born at the current schema, so
  // fresh installs never see the migration prompt. A vault that already has an
  // accounts file but no schemaVersion is a LEGACY vault — left untouched here
  // so maybeMigrate() can prompt the user before upgrading it.
  const fresh = !existsSync(ACCOUNTS_FILE);
  if (!existsSync(VAULT)) mkdirSync(VAULT, { recursive: true, mode: 0o700 });
  try {
    chmodSync(VAULT, 0o700);
  } catch {}
  if (!existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, {});
  if (!existsSync(LINKS_FILE)) writeJSON(LINKS_FILE, {});
  if (fresh && !existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, { schemaVersion: SCHEMA });
}

/** Lenient read (used for Convex's own config): any problem → fallback. */
function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Strict read for our own vault files: a missing/empty file is fine (fallback),
 * but a present-yet-unparseable file THROWS rather than silently resetting —
 * otherwise the next write would clobber a recoverable file and lose accounts.
 */
function readVaultJSON<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(raw);
    // Null prototype: account names (and other keys) come from user input, so
    // a lookup like accounts["toString"] must yield undefined — not an
    // inherited Object.prototype member that defeats every `if (!acc)` guard.
    return (
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.assign(Object.create(null), parsed)
        : parsed
    ) as T;
  } catch {
    throw new Error(
      `${file} is corrupted (invalid JSON). Fix or delete it, then re-run.`,
    );
  }
}

/**
 * Atomic write (temp file + rename): a crash mid-write can never leave a
 * truncated file behind — that matters because readVaultJSON treats a torn
 * vault file as fatal, and a torn ~/.convex/config.json would log the user out.
 */
export function writeFileAtomic(file: string, contents: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    // The temp file may hold a live token — never leave it orphaned when the
    // rename fails (e.g. Windows EPERM while another process holds the target).
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function writeJSON(file: string, data: unknown) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

export const readAccounts = () => readVaultJSON<Accounts>(ACCOUNTS_FILE, {});
export const readLinks = () => readVaultJSON<Links>(LINKS_FILE, {});
export const readConfig = () => readVaultJSON<Config>(CONFIG_FILE, {});
export function writeAccounts(a: Accounts) {
  snapshotOnce();
  writeJSON(ACCOUNTS_FILE, a);
}
export function writeLinks(l: Links) {
  snapshotOnce();
  writeJSON(LINKS_FILE, l);
}
export function writeConfig(c: Config) {
  snapshotOnce();
  writeJSON(CONFIG_FILE, c);
}

// --- Undo journal -------------------------------------------------------------
// The FIRST vault mutation of a command snapshots the whole prior state into
// backups/ (capped), so `cvx undo` can put it back. Hooked inside the write
// wrappers above, so every mutating command — rm, rename, import, scan,
// doctor --fix, storage migrations, and anything added later — is covered
// with zero per-command wiring. writeActive is NOT hooked (hot path,
// non-critical). ensureVault's first-run writes bypass the wrappers on
// purpose: an empty brand-new vault isn't worth an undo entry.

const BACKUPS = join(VAULT, "backups");
const MAX_BACKUPS = 5;

export type VaultBackup = {
  at: string;
  label: string;
  accounts: string | null;
  links: string | null;
  config: string | null;
  active: string | null;
  file: string;
};

let snapshotTaken = false;
function snapshotOnce() {
  if (snapshotTaken) return;
  snapshotTaken = true;
  try {
    if (!existsSync(ACCOUNTS_FILE)) return; // nothing meaningful to save yet
    mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
    const raw = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
    const snap = {
      at: new Date().toISOString(),
      label: process.argv.slice(2, 4).join(" ").trim() || "(unknown command)",
      accounts: raw(ACCOUNTS_FILE),
      links: raw(LINKS_FILE),
      config: raw(CONFIG_FILE),
      active: raw(ACTIVE_FILE),
    };
    // pid suffix: two cvx processes snapshotting in the same millisecond must
    // not silently overwrite each other's backup (rename replaces silently).
    writeFileAtomic(
      join(BACKUPS, `${Date.now()}-${process.pid}.json`),
      JSON.stringify(snap, null, 2) + "\n",
    );
    const files = readdirSync(BACKUPS)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS)))
      unlinkSync(join(BACKUPS, f));
  } catch {
    /* the snapshot must never block the actual operation */
  }
}

/** Undo history, newest first. Tolerates unreadable entries. */
export function listBackups(): VaultBackup[] {
  try {
    return readdirSync(BACKUPS)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => {
        try {
          return { ...JSON.parse(readFileSync(join(BACKUPS, f), "utf8")), file: join(BACKUPS, f) };
        } catch {
          return null;
        }
      })
      .filter((b): b is VaultBackup => b != null);
  } catch {
    return [];
  }
}

/**
 * Restore a backup (and consume it). The current state is snapshotted first,
 * so an undo can itself be undone. Bypasses the write wrappers deliberately —
 * raw strings go back exactly as they were.
 */
export function restoreBackup(b: VaultBackup) {
  snapshotOnce();
  const put = (file: string, content: string | null) => {
    if (content == null) {
      try {
        unlinkSync(file);
      } catch {}
    } else writeFileAtomic(file, content);
  };
  put(ACCOUNTS_FILE, b.accounts);
  put(LINKS_FILE, b.links);
  put(CONFIG_FILE, b.config);
  put(ACTIVE_FILE, b.active);
  try {
    unlinkSync(b.file);
  } catch {}
}

/**
 * Wipe the undo history. Called after tokens move to a MORE protected backend
 * (vault encrypt, keychain enable) — otherwise backups would keep the old
 * plaintext tokens on disk, silently defeating the upgrade.
 */
export function purgeBackups() {
  try {
    rmSync(BACKUPS, { recursive: true, force: true });
  } catch {}
}

// --- Token storage backend (file / OS keychain) -----------------------------

/** The configured storage backend, defaulting to plain file. */
export function storageBackend(): Backend {
  return readConfig().storage ?? "file";
}

/** Best keychain backend available on this machine (for `keychain enable`). */
export { detectBackend, deleteToken };

/** Resolve an account's actual token from wherever its record keeps it. */
export function tokenOf(name: string, acc: Account): string | null {
  if (acc.pw) return decryptToken(acc.pw); // null while the vault is locked
  return loadToken(name, acc);
}

/** Build an account record that stores `token` via the given backend. */
export function makeTokenRecord(backend: Backend, name: string, token: string): TokenRecord {
  if (backend === "passphrase") return { pw: encryptToken(token) }; // throws if locked
  return storeToken(backend, name, token);
}

/**
 * Strip the secret fields, keeping every metadata field. Removing by name
 * (instead of copying a list of keep-fields) means new Account fields survive
 * storage moves and export without anyone remembering to add them here.
 */
export function accountMeta<T extends Partial<Record<SecretField, unknown>>>(acc: T): Omit<T, SecretField> {
  const { token, keychain, enc, pw, ...meta } = acc;
  return meta;
}

/** Rebuild an account around a new token record, preserving its metadata. */
export function withTokenRecord(acc: Account, rec: TokenRecord): Account {
  return { ...accountMeta(acc), ...rec };
}

/**
 * Account names become JSON keys, OS-keychain entries, and shell-completion
 * output — restrict them to a safe charset. Requiring an alphanumeric first
 * character also blocks `__proto__` (which JSON.parse-derived objects silently
 * refuse to store as an own key, losing the account).
 */
export function validAccountName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

// --- Active-account marker --------------------------------------------------
// A fast record of which account the global config currently holds: line 1 is
// the account name, line 2 a fingerprint of its token. The cd-hook uses it to
// no-op without a slow keychain lookup — the fingerprint lets it detect that
// something else (e.g. `npx convex login`) replaced the global token, so a
// stale marker can never keep the wrong account silently "active".

const tokenFingerprint = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

function readActiveLines(): string[] {
  try {
    return readFileSync(ACTIVE_FILE, "utf8").split("\n");
  } catch {
    return [];
  }
}

export function readActive(): string | null {
  const name = readActiveLines()[0]?.trim();
  return name || null;
}

/**
 * One read of the marker: is it `name`, with a fingerprint matching `token`?
 * Markers written without a fingerprint (or in the old one-line format) never
 * match, which safely forces the caller onto the slow verified path once.
 */
export function activeMarkerMatches(name: string, token: string): boolean {
  const [n, fp] = readActiveLines();
  return n?.trim() === name && !!fp?.trim() && fp.trim() === tokenFingerprint(token);
}

export function writeActive(name: string, token?: string) {
  try {
    const fp = token ? tokenFingerprint(token) + "\n" : "";
    writeFileSync(ACTIVE_FILE, name + "\n" + fp, { mode: 0o600 });
  } catch {}
}
export function clearActive() {
  try {
    if (existsSync(ACTIVE_FILE)) writeFileSync(ACTIVE_FILE, "", { mode: 0o600 });
  } catch {}
}

// --- Convex global config (the single account switch) -----------------------

export function currentConvexToken(): string | null {
  const token = readJSON<{ accessToken?: unknown }>(CONVEX_CONFIG, {}).accessToken;
  return typeof token === "string" && token ? token : null;
}

export function setConvexToken(token: string) {
  const dir = dirname(CONVEX_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Preserve any other fields Convex may keep in the file.
  const existing = readJSON<Record<string, unknown>>(CONVEX_CONFIG, {});
  existing.accessToken = token;
  writeFileAtomic(CONVEX_CONFIG, JSON.stringify(existing, null, 2) + "\n");
}

// --- Verify a token against Convex (also reveals its teams) -----------------

export async function verifyToken(token: string): Promise<Team[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    let res: Response;
    try {
      res = await fetch(API_TEAMS, {
        headers: { Authorization: `Bearer ${token}`, "Convex-Client": CLIENT },
        signal: ctrl.signal,
      });
    } catch (e) {
      // Network-level failure (offline, DNS, timeout) — not an auth problem.
      if ((e as Error).name === "AbortError")
        throw new Error("timed out reaching Convex (check your connection)");
      throw new Error("couldn't reach Convex — are you online?");
    }
    if (res.status === 401 || res.status === 403)
      throw new Error("token rejected by Convex (expired or invalid)");
    if (!res.ok) throw new Error(`Convex API returned ${res.status}`);
    let teams: Team[];
    try {
      teams = (await res.json()) as Team[];
    } catch {
      throw new Error("Convex returned an unexpected (non-JSON) response");
    }
    if (!Array.isArray(teams)) throw new Error("Convex returned an unexpected response shape");
    return teams.map((t) => ({ slug: t.slug, name: t.name }));
  } finally {
    clearTimeout(t);
  }
}

// --- Path resolution --------------------------------------------------------

/** Canonical absolute path (resolves symlinks like /tmp -> /private/tmp). */
export function canon(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs; // path may not exist yet; fall back to normalized absolute
  }
}

export function shortPath(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

/** Which account a directory belongs to (walk up to the nearest link). */
export function resolveLink(dir: string): { path: string; account: string } | null {
  const links = readLinks();
  let cur = canon(dir);
  while (true) {
    if (links[cur]) return { path: cur, account: links[cur] };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Read the CONVEX_DEPLOYMENT line from the nearest .env.local (walking up from
 * dir): the deployment name without its `dev:`/`prod:` type prefix, and the
 * team slug from the `# team: …` comment the Convex CLI writes on that line.
 * Used by `cvx open` (deployment) and the wrong-account guard (team).
 */
export function projectEnv(dir: string): { deployment: string | null; team: string | null } {
  let cur = canon(dir);
  while (true) {
    const envFile = join(cur, ".env.local");
    if (existsSync(envFile)) {
      try {
        for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
          const m = line.match(/^\s*CONVEX_DEPLOYMENT\s*=\s*(.+?)\s*(#.*)?$/);
          if (m) {
            let v = m[1].trim().replace(/^["']|["']$/g, "");
            // strip an inline "# team: ..." comment tail and the type prefix
            v = v.split("#")[0].trim();
            v = v.replace(/^(dev|prod|local|preview):/, "");
            const team = (m[2] ?? "").match(/#\s*team:\s*([A-Za-z0-9._-]+)/)?.[1] ?? null;
            // The deployment lands in a URL handed to the OS opener
            // (`cmd /c start` on Windows) — only accept real deployment-name
            // characters, so a hostile .env.local can't smuggle shell
            // metacharacters through.
            return { deployment: /^[A-Za-z0-9._-]+$/.test(v) ? v : null, team };
          }
        }
      } catch {
        /* unreadable env — ignore */
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return { deployment: null, team: null };
    cur = parent;
  }
}

export function projectDeployment(dir: string): string | null {
  return projectEnv(dir).deployment;
}

/** Name of the account whose token the global config currently holds. */
export function activeAccountName(accounts: Accounts): string | null {
  const cur = currentConvexToken();
  if (!cur) return null;
  const marked = readActive();
  if (marked && accounts[marked] && tokenOf(marked, accounts[marked]) === cur) return marked;
  for (const [name, acc] of Object.entries(accounts)) if (tokenOf(name, acc) === cur) return name;
  return null;
}

// --- First-run state --------------------------------------------------------

export const isFirstRun = () => !existsSync(WELCOME_MARKER);
export function markWelcomed() {
  try {
    writeFileSync(WELCOME_MARKER, new Date().toISOString() + "\n", { mode: 0o600 });
  } catch {}
}
