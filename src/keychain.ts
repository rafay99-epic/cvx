/**
 * keychain — OS-backed secret storage, opt-in. Three backends:
 *   macOS   → Keychain via the `security` CLI
 *   Linux   → libsecret via `secret-tool` (if installed)
 *   Windows → DPAPI-encrypted blob (per-user) via PowerShell; the ciphertext is
 *             handed back to the caller to store in the vault (no external store)
 *
 * The abstraction returns one of three record shapes per account token:
 *   { token }       inline plaintext (default file vault)
 *   { keychain }    secret lives in the OS keychain, keyed by account name
 *   { enc }         DPAPI ciphertext, stored in the vault file (Windows)
 */

import { spawnSync } from "node:child_process";

const SERVICE = "convex-switch";

// "passphrase" records are handled by vault.ts (store.ts routes them there);
// it appears in this union because it's a `config.storage` value like the rest.
export type Backend = "file" | "macos" | "libsecret" | "dpapi" | "passphrase";

function sh(cmd: string, args: string[], input?: string) {
  return spawnSync(cmd, args, { encoding: "utf8", input, timeout: 15000 });
}

/** The OS keychain a `keychain: true` record's secret lives in on this platform. */
export function platformKeychain(): Backend {
  return process.platform === "darwin" ? "macos" : "libsecret";
}

/** Which OS keychain backend is usable on this machine, if any. */
export function detectBackend(): Backend {
  if (process.platform === "darwin") {
    return sh("security", ["help"]).error ? "file" : "macos";
  }
  if (process.platform === "win32") return "dpapi"; // PowerShell + DPAPI are always present
  // linux/other
  return sh("secret-tool", ["--version"]).error ? "file" : "libsecret";
}

export function backendLabel(b: Backend): string {
  return {
    file: "plain file (chmod 600)",
    macos: "macOS Keychain",
    libsecret: "libsecret (GNOME Keyring / KWallet)",
    dpapi: "Windows DPAPI",
    passphrase: "passphrase-encrypted file",
  }[b];
}

// --- macOS -----------------------------------------------------------------
function macSet(account: string, token: string): boolean {
  // `security -i` reads the command from stdin, so the token never appears in
  // the process argv (visible to `ps` for the duration of the spawn — Apple's
  // own man page flags `-w <password>` as insecure). Inside the double-quoted
  // string only backslash and double-quote are special; account names are
  // already restricted to [A-Za-z0-9._-] by validAccountName.
  if (/[\r\n]/.test(token)) return false; // would terminate the stdin command
  const quoted = '"' + token.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const r = sh(
    "security",
    ["-i"],
    `add-generic-password -U -a ${account} -s ${SERVICE} -w ${quoted}\n`,
  );
  return !r.error && r.status === 0;
}
function macGet(account: string): string | null {
  const r = sh("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
  return !r.error && r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}
function macDel(account: string): boolean {
  const r = sh("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
  return !r.error && r.status === 0;
}

// --- Linux (libsecret) -----------------------------------------------------
function secretSet(account: string, token: string): boolean {
  const r = sh(
    "secret-tool",
    ["store", "--label", `convex-switch: ${account}`, "service", SERVICE, "account", account],
    token,
  );
  return !r.error && r.status === 0;
}
function secretGet(account: string): string | null {
  const r = sh("secret-tool", ["lookup", "service", SERVICE, "account", account]);
  return !r.error && r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}
function secretDel(account: string): boolean {
  const r = sh("secret-tool", ["clear", "service", SERVICE, "account", account]);
  return !r.error && r.status === 0;
}

// --- Windows (DPAPI via PowerShell) ----------------------------------------
// Returns ciphertext to store in the vault; decrypt reverses it.
function dpapiProtect(token: string): string | null {
  const script =
    "$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());" +
    "Add-Type -AssemblyName System.Security;" +
    "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
    "[Console]::Out.Write([Convert]::ToBase64String($e))";
  const r = sh("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], token);
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}
function dpapiUnprotect(enc: string): string | null {
  const script =
    "$e=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser');" +
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))";
  const r = sh("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], enc);
  return !r.error && r.status === 0 ? r.stdout : null;
}

/**
 * Store a token in the given backend. Returns the vault record for the account:
 *  - macos/libsecret: { keychain: true }  (secret is out-of-file)
 *  - dpapi:           { enc: "<base64>" } (ciphertext lives in the vault)
 *  - file:            { token }            (plaintext)
 * Throws with a clear message if the backend write fails.
 */
export function storeToken(
  backend: Backend,
  account: string,
  token: string,
): { token?: string; keychain?: boolean; enc?: string } {
  switch (backend) {
    case "macos":
      if (!macSet(account, token)) throw new Error("failed to write to the macOS Keychain");
      return { keychain: true };
    case "libsecret":
      if (!secretSet(account, token)) throw new Error("failed to write to libsecret (is a keyring running?)");
      return { keychain: true };
    case "dpapi": {
      const enc = dpapiProtect(token);
      if (!enc) throw new Error("failed to encrypt with Windows DPAPI");
      return { enc };
    }
    default:
      return { token };
  }
}

/** Resolve an account's token from whichever backend its record indicates. */
export function loadToken(
  account: string,
  rec: { token?: string; keychain?: boolean; enc?: string },
): string | null {
  if (rec.keychain) {
    // mac or linux keychain (name-keyed)
    return process.platform === "darwin" ? macGet(account) : secretGet(account);
  }
  if (rec.enc) return dpapiUnprotect(rec.enc);
  return rec.token ?? null;
}

/**
 * Remove any keychain-side secret for an account (no-op for file/dpapi).
 * Returns false when a keychain-backed secret could not be deleted, so callers
 * can warn instead of silently orphaning a live credential.
 */
export function deleteToken(account: string, rec: { keychain?: boolean }): boolean {
  if (!rec.keychain) return true;
  return process.platform === "darwin" ? macDel(account) : secretDel(account);
}
