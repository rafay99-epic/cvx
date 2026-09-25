/**
 * storage — where tokens live and how the vault recovers: keychain, vault,
 * undo, reset, disable, enable.
 */

import { readFileSync } from "node:fs";
import { type Backend, backendLabel, deleteToken, detectBackend } from "../keychain";
import {
  ACCOUNTS_FILE,
  LINKS_FILE,
  SCHEMA,
  type Accounts,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  readConfig,
  writeConfig,
  tokenOf,
  makeTokenRecord,
  withTokenRecord,
  storageBackend,
  clearActive,
  listBackups,
  restoreBackup,
  purgeBackups,
} from "../store";
import { vaultInitialized, vaultLocked, initVault, destroyVaultMeta, unlock, lock } from "../vault";
import { bold, dim, green, yellow, red, die, askHidden, vexTag } from "../ui";
import { parseFlags } from "../args";
import { ask, warnIfSecretLeft } from "./shared";

/**
 * reset — nuke ALL cvx state: every account, link, the active marker, the
 * passphrase-vault metadata + its cached session key, keychain secrets, and
 * the undo history (backups hold old tokens, so a reset must not keep them).
 * The user's `npx convex login` (~/.convex/config.json) is left untouched.
 */
export async function cmdReset(args: string[]) {
  const flags = parseFlags(args);
  // A corrupt vault must not block the one command that wipes it clean.
  let accounts: Accounts = {};
  try {
    accounts = readAccounts();
  } catch {}
  let nLinks = 0;
  try {
    nLinks = Object.keys(readLinks()).length;
  } catch {}
  const nAcc = Object.keys(accounts).length;

  if (!flags.force && !flags.yes) {
    if (!process.stdin.isTTY)
      die(`cvx reset deletes ALL accounts and links (NOT undoable). Pass ${bold("--force")} to confirm.`);
    const yn = await ask(
      `${red("This deletes ALL cvx state")} — ${bold(String(nAcc))} account(s), ${bold(String(nLinks))} link(s), every session, and the undo history (${bold("not")} undoable). Continue? [y/N] `,
    );
    if (!/^y(es)?$/i.test(yn)) return console.log(dim("Cancelled — nothing deleted."));
  }

  // Vault first, keychain secrets after (same order as `rm`): a failed secret
  // delete leaves an orphan secret, never a record pointing at a deleted one.
  writeAccounts({});
  writeLinks({});
  writeConfig({ schemaVersion: SCHEMA }); // storage backend back to the default
  clearActive();
  for (const [name, acc] of Object.entries(accounts)) warnIfSecretLeft(name, deleteToken(name, acc));
  destroyVaultMeta(); // passphrase salt + the cached vault-session key
  purgeBackups();
  console.log(
    `${green("✓")} Reset — removed ${nAcc} account(s) and ${nLinks} link(s).${vexTag("sad")}`,
  );
  console.log(
    dim("  Open terminals unbind on their next cd. Your `npx convex login` is untouched."),
  );
}

/** disable — park cvx: the cd hook stops switching accounts until `cvx enable`. */
export function cmdDisable() {
  const c = readConfig();
  if (c.disabled) return console.log(dim("cvx is already disabled."));
  writeConfig({ ...c, disabled: true });
  console.log(
    `${yellow("⏸")} cvx disabled — the cd hook won't switch accounts. Resume: ${bold("cvx enable")}${vexTag("sleepy")}`,
  );
  console.log(dim("  Open terminals unbind on their next cd; nothing is deleted."));
}

export function cmdEnable() {
  const c = readConfig();
  if (!c.disabled) return console.log(dim("cvx is already enabled."));
  delete c.disabled;
  writeConfig(c);
  console.log(`${green("▶")} cvx enabled — accounts switch on cd again.${vexTag("happy")}`);
}

// --- keychain ---------------------------------------------------------------

export function cmdKeychain(args: string[]) {
  const sub = args[0] || "status";
  const accounts = readAccounts();
  const cfg = readConfig();
  const current: Backend = cfg.storage ?? "file";
  const available = detectBackend();

  if (sub === "status") {
    console.log(bold("Token storage") + "\n");
    console.log(`  current    ${bold(current)} ${dim(`(${backendLabel(current)})`)}`);
    console.log(`  available  ${bold(available)} ${dim(`(${backendLabel(available)})`)}`);
    if (current === "file" && available !== "file")
      console.log(dim(`\n  Run \`cvx keychain enable\` to move tokens into ${backendLabel(available)}.`));
    return;
  }
  if (sub === "enable") {
    if (available === "file")
      die(
        "No OS keychain is available here.\n  macOS uses Keychain; Linux needs `secret-tool` (libsecret); Windows uses DPAPI.",
      );
    migrateStorage(accounts, available);
    writeConfig({ ...cfg, storage: available });
    if (cfg.storage === "passphrase") destroyVaultMeta(); // tokens left the encrypted vault
    purgeBackups(); // undo history held the plaintext tokens
    const n = Object.keys(accounts).length;
    console.log(
      (n
        ? `${green("✓")} Moved ${n} account(s) into ${bold(backendLabel(available))}.`
        : `${green("✓")} Token storage set to ${bold(backendLabel(available))} — new accounts will be stored there.`) +
        vexTag("happy"),
    );
    return;
  }
  if (sub === "disable") {
    migrateStorage(accounts, "file");
    writeConfig({ ...cfg, storage: "file" });
    if (cfg.storage === "passphrase") destroyVaultMeta(); // tokens left the encrypted vault
    console.log(`${green("✓")} Moved tokens back to the file vault (chmod 600).${vexTag("happy")}`);
    return;
  }
  die(`Usage: ${bold("cvx keychain <status|enable|disable>")}`);
}

/** Move every account's token to `target`, then clean up the old keychain secrets. */
function migrateStorage(accounts: Accounts, target: Backend) {
  const names = Object.keys(accounts);
  if (!names.length) return;
  // 1) read every token up front — abort cleanly if any can't be read.
  const tokens: Record<string, string> = {};
  for (const name of names) {
    const t = tokenOf(name, accounts[name]);
    if (t == null) die(`Couldn't read the token for ${bold(name)} — aborting, nothing changed.`);
    tokens[name] = t;
  }
  // 2) write all to the new backend (side effects), building new records.
  // If one write throws partway through, delete the keychain secrets the
  // earlier iterations just created (only those — never a secret an existing
  // record still depends on), so an aborted migration leaves no live token
  // orphaned in the keychain.
  const next: Accounts = {};
  const freshSecrets: string[] = [];
  try {
    for (const name of names) {
      const rec = makeTokenRecord(target, name, tokens[name]); // may throw before we commit
      if (rec.keychain && !accounts[name].keychain) freshSecrets.push(name);
      next[name] = withTokenRecord(accounts[name], rec);
    }
  } catch (e) {
    for (const name of freshSecrets) deleteToken(name, { keychain: true });
    throw e;
  }
  // 3) commit, then delete now-orphaned keychain secrets.
  writeAccounts(next);
  for (const name of names) {
    if (accounts[name].keychain && !next[name].keychain)
      warnIfSecretLeft(name, deleteToken(name, accounts[name]));
  }
}

// --- undo ---------------------------------------------------------------------

/** "3m ago" / "2h ago" / "5d ago" for undo history. */
function agoPrecise(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

/** Counts from a raw snapshot/vault JSON string; "?" when unparseable. */
function countIn(raw: string | null): string {
  if (raw == null) return "0";
  try {
    return String(Object.keys(JSON.parse(raw)).length);
  } catch {
    return "?";
  }
}

export async function cmdUndo(args: string[]) {
  const flags = parseFlags(args);
  const backups = listBackups();

  if (flags.list) {
    if (!backups.length)
      return console.log(dim("No undo history yet — a snapshot is taken before every change."));
    console.log(bold("Undo history") + dim(" (newest first — `cvx undo` restores the top one)"));
    for (const b of backups)
      console.log(`  ${dim(agoPrecise(b.at).padEnd(11))} before ${bold(b.label)}`);
    return;
  }

  if (!backups.length) die("Nothing to undo — no snapshots recorded yet.");
  const b = backups[0];

  // Read current counts raw so undo still works when a vault file is corrupt —
  // that is exactly the situation undo exists to rescue.
  const raw = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  const curAccounts = raw(ACCOUNTS_FILE);
  const curLinks = raw(LINKS_FILE);

  console.log(
    `Restore the vault to how it was before ${bold(b.label)} ${dim(`(${agoPrecise(b.at)})`)}?`,
  );
  console.log(
    dim(
      `  accounts ${countIn(curAccounts)} → ${countIn(b.accounts)} · links ${countIn(curLinks)} → ${countIn(b.links)}`,
    ),
  );
  if (!flags.yes) {
    if (!process.stdin.isTTY)
      die(`Confirmation needed — re-run with ${bold("--yes")} in scripts.`);
    const yn = await ask("Restore? [y/N] ");
    if (!/^y(es)?$/i.test(yn)) return console.log(dim("Cancelled — nothing restored."));
  }

  restoreBackup(b);
  console.log(`${green("✓")} Vault restored ${dim(`(to before ${b.label})`)}.${vexTag("happy")}`);
  console.log(dim("  `cvx undo` again reverses this restore."));
  if (keychainBacked(b.accounts))
    console.log(
      yellow("! ") +
        "restored records reference the OS keychain — a secret deleted from the keychain itself cannot be restored (re-add with `cvx refresh <name>`).",
    );
}

// --- vault (passphrase-encrypted tokens) -------------------------------------

async function newPassphrase(): Promise<string> {
  const env = process.env.CVX_PASSPHRASE;
  if (env !== undefined) {
    if (env.length < 8) die("CVX_PASSPHRASE must be at least 8 characters.");
    return env;
  }
  const a = await askHidden("New passphrase (min 8 chars): ");
  if (a.length < 8) die("Passphrase must be at least 8 characters — nothing changed.");
  const b = await askHidden("Repeat passphrase: ");
  if (a !== b) die("Passphrases didn't match — nothing changed.");
  return a;
}

export async function cmdVault(args: string[]) {
  const sub = parseFlags(args)._[0] || "status";
  const cfg = readConfig();

  if (sub === "status") {
    const backend = storageBackend();
    console.log(bold("Vault encryption") + "\n");
    if (backend === "passphrase") {
      console.log(`  ${green("●")} passphrase-encrypted ${vaultLocked() ? yellow("(locked)") : dim("(unlocked)")}`);
      console.log(dim(`  cvx vault ${vaultLocked() ? "unlock" : "lock"} · cvx vault decrypt to turn off`));
    } else {
      console.log(`  ${dim("○")} not encrypted ${dim(`(tokens in ${backendLabel(backend)})`)}`);
      console.log(dim("  Run `cvx vault encrypt` to protect tokens with a passphrase."));
    }
    return;
  }

  if (sub === "encrypt") {
    if (storageBackend() === "passphrase")
      return console.log(yellow("Vault is already passphrase-encrypted."));
    const accounts = readAccounts();
    // Pre-flight: every token must be readable BEFORE any vault state exists,
    // so a failure changes nothing.
    for (const [n, acc] of Object.entries(accounts))
      if (tokenOf(n, acc) == null)
        die(`Couldn't read the token for ${bold(n)} — aborting, nothing changed.`);
    initVault(await newPassphrase());
    migrateStorage(accounts, "passphrase");
    writeConfig({ ...cfg, storage: "passphrase" });
    purgeBackups(); // undo history held the plaintext tokens
    console.log(
      `${green("✓")} Tokens encrypted with your passphrase ${dim("(unlocked for this session)")}.${vexTag("wink")}`,
    );
    console.log(dim("  `cvx vault lock` locks it; a reboot locks it too."));
    return;
  }

  if (sub === "decrypt") {
    if (storageBackend() !== "passphrase") die("Vault isn't passphrase-encrypted.");
    if (vaultLocked()) die(`Vault is locked — run ${bold("cvx vault unlock")} first.`);
    migrateStorage(readAccounts(), "file");
    writeConfig({ ...cfg, storage: "file" });
    destroyVaultMeta();
    console.log(`${green("✓")} Tokens moved back to the plain file vault (chmod 600).${vexTag("happy")}`);
    return;
  }

  if (sub === "unlock") {
    if (!vaultInitialized()) die("Vault isn't passphrase-encrypted. Set it up with `cvx vault encrypt`.");
    const pass = process.env.CVX_PASSPHRASE ?? (await askHidden("Passphrase: "));
    if (!unlock(pass)) die("Wrong passphrase.");
    console.log(`${green("✓")} Vault unlocked for this session.${vexTag("happy")}`);
    return;
  }

  if (sub === "lock") {
    lock();
    console.log(`${green("✓")} Vault locked. Unlock with ${bold("cvx vault unlock")}.${vexTag("sleepy")}`);
    return;
  }

  die(`Usage: ${bold("cvx vault <status|encrypt|decrypt|unlock|lock>")}`);
}

/** Does a raw accounts.json snapshot hold any OS-keychain-backed record? */
function keychainBacked(raw: string | null): boolean {
  try {
    return Object.values(JSON.parse(raw ?? "{}") as Accounts).some((a) => a.keychain);
  } catch {
    return false;
  }
}
