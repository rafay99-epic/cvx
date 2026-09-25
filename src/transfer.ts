/**
 * transfer — passphrase-encrypted vault backup for moving to a new machine.
 * `cvx export` resolves every account's token inline and seals { accounts, links }
 * with scrypt + AES-256-GCM; `cvx import` decrypts and MERGES into the local vault.
 * The pure core (packVault/unpackVault) is separated from the commands so it can
 * be unit-tested without a TTY or a live keychain.
 */

import { existsSync, readFileSync, chmodSync } from "node:fs";
import { encrypt, decrypt, deriveKey, newSalt } from "./crypto";
import {
  readAccounts,
  writeAccounts,
  writeFileAtomic,
  readLinks,
  writeLinks,
  tokenOf,
  makeTokenRecord,
  storageBackend,
  validAccountName,
  accountMeta,
  type AccountMeta,
  type Links,
} from "./store";
import { parseFlags } from "./args";
import { die, bold, dim, green, yellow, askHidden, vexTag } from "./ui";

// An account travels with its token RESOLVED inline, so a keychain-backed record
// still imports portably on a machine that has never seen the original keychain.
type ExportedAccount = AccountMeta & { token: string };
type Payload = { accounts: Record<string, ExportedAccount>; links: Links };

const DEFAULT_FILE = "cvx-vault.export";

// --- Pure core (unit-testable) ----------------------------------------------

/** Seal the current vault (tokens resolved inline) into an export file's contents. */
export function packVault(passphrase: string): string {
  const accounts = readAccounts();
  const exported: Record<string, ExportedAccount> = {};
  for (const [name, acc] of Object.entries(accounts)) {
    const token = tokenOf(name, acc);
    // Bail before writing anything — a partial/tokenless export is worse than none.
    if (token == null) throw new Error(`Couldn't read the token for ${name}. Aborting export (nothing was written).`);
    exported[name] = { ...accountMeta(acc), token };
  }
  const payload: Payload = { accounts: exported, links: readLinks() };
  const salt = newSalt();
  const data = encrypt(deriveKey(passphrase, salt), JSON.stringify(payload));
  return (
    JSON.stringify({ v: 1, kind: "cvx-export", salt: salt.toString("base64"), data }, null, 2) + "\n"
  );
}

/** Reverse packVault. null on wrong passphrase, tampering, or a non-export file. */
export function unpackVault(passphrase: string, blob: string): Payload | null {
  let outer: { kind?: unknown; salt?: unknown; data?: unknown };
  try {
    outer = JSON.parse(blob);
  } catch {
    return null;
  }
  if (outer.kind !== "cvx-export" || typeof outer.salt !== "string" || typeof outer.data !== "string")
    return null;
  const plain = decrypt(deriveKey(passphrase, Buffer.from(outer.salt, "base64")), outer.data);
  if (plain == null) return null;
  try {
    const payload = JSON.parse(plain) as Payload;
    // Validate the decrypted shape too: a decryptable-but-malformed archive
    // must not import as garbage tokenless accounts.
    const isObj = (v: unknown): v is Record<string, unknown> =>
      v != null && typeof v === "object" && !Array.isArray(v);
    const accounts = payload?.accounts ?? {};
    const links = payload?.links ?? {};
    if (!isObj(accounts) || !isObj(links)) return null;
    for (const inc of Object.values(accounts))
      if (!isObj(inc) || typeof inc.token !== "string") return null;
    for (const name of Object.values(links)) if (typeof name !== "string") return null;
    return { accounts: accounts as Payload["accounts"], links: links as Links };
  } catch {
    return null;
  }
}

// --- Commands ----------------------------------------------------------------

async function exportPassphrase(): Promise<string> {
  const env = process.env.CVX_PASSPHRASE;
  if (env) {
    if (env.length < 8) die("CVX_PASSPHRASE must be at least 8 characters.");
    return env;
  }
  const p1 = await askHidden("Passphrase (min 8 chars): ");
  if (p1.length < 8) die("Passphrase must be at least 8 characters.");
  const p2 = await askHidden("Confirm passphrase: ");
  if (p1 !== p2) die("Passphrases don't match.");
  return p1;
}

export async function cmdExport(args: string[]) {
  const flags = parseFlags(args);
  const file = flags._[0] ?? DEFAULT_FILE;
  const nAcc = Object.keys(readAccounts()).length;
  if (!nAcc) die("No accounts to export. Run `cvx login <name>` first.");

  const blob = packVault(await exportPassphrase());
  writeFileAtomic(file, blob);
  try {
    chmodSync(file, 0o600);
  } catch {}

  const nLinks = Object.keys(readLinks()).length;
  console.log(
    `${green("✓")} Exported ${bold(String(nAcc))} account${nAcc === 1 ? "" : "s"} and ` +
      `${bold(String(nLinks))} link${nLinks === 1 ? "" : "s"} to ${bold(file)}${vexTag("happy")}`,
  );
  console.log(
    yellow(`  ⚠ This file holds LIVE credentials — keep it secret and delete it after importing.`),
  );
}

export async function cmdImport(args: string[]) {
  const flags = parseFlags(args);
  const file = flags._[0];
  if (!file) die(`Usage: ${bold("cvx import <file>")}`);
  if (!existsSync(file)) die(`File not found: ${file}`);

  const passphrase = process.env.CVX_PASSPHRASE || (await askHidden("Passphrase: "));
  const payload = unpackVault(passphrase, readFileSync(file, "utf8"));
  if (!payload) die("Couldn't decrypt: wrong passphrase, or the file is corrupted or tampered with.");

  const accounts = readAccounts();
  const backend = storageBackend();
  let added = 0,
    overwritten = 0,
    skipped = 0;
  for (const [name, inc] of Object.entries(payload.accounts)) {
    const exists = Object.hasOwn(accounts, name);
    // Grandfather names that already exist locally; only new names must be valid.
    if (!exists && !validAccountName(name)) {
      console.log(yellow(`  ⚠ Skipping account with invalid name: ${bold(name)}`));
      skipped++;
      continue;
    }
    if (exists && !flags.force) {
      console.log(dim(`  Skipping existing account ${bold(name)} (use --force to overwrite)`));
      skipped++;
      continue;
    }
    let rec;
    try {
      rec = makeTokenRecord(backend, name, inc.token);
    } catch (e) {
      // Accounts imported before this one already have secrets in the OS
      // keychain — persist them so nothing live is left orphaned and untracked.
      if (added + overwritten) writeAccounts(accounts);
      die(`Couldn't store the token for ${bold(name)}: ${(e as Error).message}`);
    }
    // accountMeta drops any secret fields a crafted file might carry (a stray
    // `pw` would outrank the new token in tokenOf).
    accounts[name] = {
      ...accountMeta(inc),
      teams: Array.isArray(inc.teams) ? inc.teams : [],
      addedAt: inc.addedAt ?? new Date().toISOString(),
      ...rec,
    };
    exists ? overwritten++ : added++;
  }
  writeAccounts(accounts);

  const links = readLinks();
  let linksMerged = 0,
    linksKept = 0;
  for (const [path, name] of Object.entries(payload.links)) {
    if (Object.hasOwn(links, path) && !flags.force) {
      linksKept++;
      continue;
    }
    links[path] = name;
    linksMerged++;
  }
  writeLinks(links);

  console.log(
    `${green("✓")} Import complete: ${bold(String(added))} added, ` +
      `${bold(String(overwritten))} overwritten, ${bold(String(skipped))} skipped.${vexTag("happy")}`,
  );
  console.log(dim(`  Links: ${linksMerged} merged, ${linksKept} kept.`));
}
