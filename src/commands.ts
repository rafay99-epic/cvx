/** commands — one function per subcommand. Glue between store + ui. */

import { existsSync, statSync, readFileSync, readdirSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { type Shell, hookFor, detectShell, SHELLS, HOOK_MARKER, RC_FILES, replaceHookBlock, envLine } from "./hooks";
import { hasCommand, isWindows, openUrl, runInherit } from "./system";
import { type Backend, backendLabel, platformKeychain } from "./keychain";
import { completionFor } from "./completions";
import {
  HOME,
  VAULT,
  VERSION,
  SCHEMA,
  type Team,
  type Account,
  type Accounts,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  readConfig,
  writeConfig,
  currentConvexToken,
  setConvexToken,
  verifyToken,
  resolveLink,
  canon,
  shortPath,
  tokenOf,
  makeTokenRecord,
  withTokenRecord,
  validAccountName,
  storageBackend,
  detectBackend,
  deleteToken,
  readActive,
  writeActive,
  activeMarkerMatches,
  clearActive,
  activeAccountName,
  projectDeployment,
  projectEnv,
  listBackups,
  restoreBackup,
  purgeBackups,
} from "./store";
import { vaultInitialized, vaultLocked, initVault, destroyVaultMeta, unlock, lock } from "./vault";
import {
  bold,
  dim,
  green,
  yellow,
  red,
  cyan,
  die,
  teamLabel,
  askHidden,
  accountColor,
  vex,
  vexTag,
  type VexMood,
} from "./ui";
import { spin } from "./spinner";
import { accountColorCode } from "./colors";
import { parseFlags } from "./args";

// --- small helpers ----------------------------------------------------------

function requireAccount(accounts: Accounts, name: string): Account {
  const acc = accounts[name];
  if (!acc)
    die(
      `Unknown account ${bold(name)}. Known: ${Object.keys(accounts).join(", ") || "(none)"}`,
    );
  return acc;
}

/**
 * Account bound to THIS shell session by the hook's `activate --env` export.
 * CONVEX_OVERRIDE_ACCESS_TOKEN beats the global config inside the Convex CLI,
 * so when it's set, the session var — not the global marker — is the truth.
 */
function sessionAccount(accounts: Accounts): string | null {
  const name = process.env.CVX_ACCOUNT;
  if (!process.env.CONVEX_OVERRIDE_ACCESS_TOKEN || !name) return null;
  return Object.hasOwn(accounts, name) ? name : null;
}

function requireValidName(name: string) {
  if (!validAccountName(name))
    die(
      `Invalid account name ${bold(name)}.\n` +
        `  Use letters, digits, dots, dashes or underscores, starting with a letter or digit.`,
    );
}

/** "today" / "3d ago" from an ISO timestamp, or null when unknown. */
function ago(iso?: string): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  return days === 0 ? "today" : `${days}d ago`;
}

/**
 * Wrong-account guard: the Convex CLI writes a `# team: …` note on the
 * CONVEX_DEPLOYMENT line of .env.local. If that team isn't one the account
 * belongs to, this project would deploy to a DIFFERENT account than the one
 * being activated — say so loudly, even in quiet (hook) mode.
 */
function mismatchedTeam(dir: string, acc: Account): string | null {
  if (!acc.teams.length) return null; // unverified account — nothing to compare
  const team = projectEnv(dir).team;
  if (!team || acc.teams.some((t) => t.slug === team)) return null;
  return team;
}

function warnTeamMismatch(dir: string, name: string, acc: Account, say = console.log) {
  const team = mismatchedTeam(dir, acc);
  if (!team) return;
  say(
    `${yellow("▲")} team mismatch: this project's deployment belongs to ${bold(team)}, ` +
      `but ${bold(name)} only has ${acc.teams.map((t) => t.slug).join(", ")}.\n` +
      dim("  Linked to the wrong account? Fix with: cvx link <account>\n") +
      dim("  Team renamed on Convex? Refresh the stored team list with: cvx doctor"),
  );
}

/** Warn (don't fail) when an account's OS-keychain secret couldn't be removed. */
function warnIfSecretLeft(name: string, deleted: boolean) {
  if (!deleted)
    console.error(
      yellow("! ") +
        `couldn't remove ${bold(name)}'s secret from the OS keychain — ` +
        `delete the "convex-switch" entry for it manually.`,
    );
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// --- add / login ------------------------------------------------------------

export async function cmdAdd(args: string[]) {
  const flags = parseFlags(args);
  let name = flags._[0];
  if (flags.token === true) die(`${bold("--token")} needs a value: ${bold("cvx add <name> --token <token>")}`);
  let token: string | null = (flags.token as string) ?? null;

  // Validate a user-supplied NEW name before the network round-trip. Existing
  // names are grandfathered so `cvx refresh`/`cvx login` keep working for
  // accounts created before validation existed. Object.hasOwn (not
  // accounts[name]) so "__proto__" can't sneak past via the prototype.
  if (name && !Object.hasOwn(readAccounts(), name)) requireValidName(name);

  if (!token) {
    token = currentConvexToken();
    if (!token)
      die(
        `No token given and ${cyan("~/.convex/config.json")} has none.\n` +
          `  Log into the account first:  ${bold("npx convex login")}\n` +
          `  or:  ${bold("cvx login <name>")}   (logs in, then stores it)`,
      );
    console.log(dim(`Using the token currently in ~/.convex/config.json`));
  }

  const sp = spin("Verifying with Convex… ");
  let teams: Team[] = [];
  try {
    teams = await verifyToken(token);
    sp.stop(`Verifying with Convex… ${green("ok")}`);
  } catch (e) {
    sp.stop(`Verifying with Convex… ${red("failed")}`);
    die(String((e as Error).message));
  }

  if (!name) {
    const slug = teams[0]?.slug;
    name = slug && validAccountName(slug) ? slug : "account";
  }
  const accounts = readAccounts();
  if (accounts[name] && !flags.force)
    die(`Account ${bold(name)} already exists. Use ${bold("--force")} to overwrite.`);

  // Which email is this? Convex's API won't tell us (the profile endpoint
  // rejects CLI tokens), so ask once — optional, purely a label for humans.
  let email = typeof flags.email === "string" ? flags.email.trim() : (accounts[name]?.email ?? "");
  if (!email && process.stdin.isTTY)
    email = await ask(dim(`Email of this account (optional, helps tell accounts apart): `));

  const backend = storageBackend();
  let rec;
  try {
    rec = makeTokenRecord(backend, name, token);
  } catch (e) {
    die(`Couldn't store the token: ${(e as Error).message}`);
  }
  const now = new Date().toISOString();
  accounts[name] = { ...rec, teams, addedAt: accounts[name]?.addedAt ?? now, verifiedAt: now };
  if (email) accounts[name].email = email;
  writeAccounts(accounts);
  if (token === currentConvexToken()) writeActive(name, token);

  const where = backend === "file" ? "" : dim(` (${backendLabel(backend)})`);
  console.log(
    `${green("✓")} Stored account ${accountColor(name)} ${teamLabel(accounts[name])}${where}${vexTag("happy", name)}`,
  );
  console.log(dim(`  Next: cd into a project and run  ${bold(`cvx link ${name}`)}`));
}

/** Run `npx convex login --force` interactively, then store the result as `name`. */
function loginAndStore(name: string, banner: string) {
  console.log(dim(banner));
  const r = runInherit("npx", ["--yes", "convex", "login", "--force"], process.env);
  if (r.error) die(`Could not run convex login: ${r.error.message}`);
  if (r.status !== 0) die("convex login did not complete.");
  return cmdAdd([name, "--force"]);
}

export function cmdLogin(args: string[]) {
  const name = parseFlags(args)._[0];
  if (!name) die(`Usage: ${bold("cvx login <name>")}`);
  requireValidName(name);
  if (!hasCommand("npx"))
    die(
      `${bold("npx")} (Node.js) was not found on your PATH.\n` +
        `  Convex's CLI runs via npx — install Node from https://nodejs.org and retry.\n` +
        `  Already logged in elsewhere? Use ${bold(`cvx add ${name}`)} to store the current login.`,
    );
  return loginAndStore(name, "Opening Convex login (forces a fresh browser sign-in)…");
}

/** Re-authenticate an existing account (sign in again, refresh its token). */
export async function cmdRefresh(args: string[]) {
  const flags = parseFlags(args);
  if (flags.all) {
    const names = Object.keys(readAccounts());
    if (!names.length) die("No accounts yet. Run `cvx login <name>` first.");
    if (!hasCommand("npx")) die(`${bold("npx")} (Node.js) not found — needed to re-authenticate.`);
    console.log(bold(`Re-authenticating ${names.length} account(s)`) + dim(" — one browser sign-in each."));
    for (const [i, name] of names.entries()) {
      console.log(`\n${cyan(`[${i + 1}/${names.length}]`)} ${bold(name)}`);
      await loginAndStore(name, `Sign into ${bold(name)} in the browser…`);
    }
    console.log(`\n${green("✓")} All accounts refreshed.${vexTag("excited")}`);
    return;
  }
  const name = flags._[0];
  if (!name) die(`Usage: ${bold("cvx refresh <account>")}   (or: cvx refresh --all)`);
  const accounts = readAccounts();
  if (!accounts[name])
    die(`Unknown account ${bold(name)}. Use ${bold(`cvx login ${name}`)} to add it.`);
  if (!hasCommand("npx")) die(`${bold("npx")} (Node.js) not found — needed to re-authenticate.`);
  return loginAndStore(name, `Re-authenticating ${bold(name)} — sign into that account in the browser…`);
}

// --- link / unlink / rename / rm --------------------------------------------

export function cmdLink(args: string[]) {
  const flags = parseFlags(args);
  const account = flags._[0];
  if (!account) die(`Usage: ${bold("cvx link <account> [path]")}`);
  const accounts = readAccounts();
  const acc = requireAccount(accounts, account);

  const input = flags._[1] ?? process.cwd();
  if (!existsSync(resolve(input))) die(`Path does not exist: ${input}`);
  if (!statSync(resolve(input)).isDirectory()) die(`Not a directory: ${input}`);
  const target = canon(input);

  const links = readLinks();
  links[target] = account;
  writeLinks(links);
  console.log(
    `${green("✓")} Linked ${bold(shortPath(target))} → ${accountColor(account)} ${teamLabel(acc)}${vexTag("happy", account)}`,
  );
}

export function cmdUnlink(args: string[]) {
  const target = canon(args[0] ?? process.cwd());
  const links = readLinks();
  if (!links[target]) die(`No link at ${shortPath(target)}`);
  delete links[target];
  writeLinks(links);
  console.log(`${green("✓")} Unlinked ${bold(shortPath(target))}${vexTag("sad")}`);
}

export function cmdRename(args: string[]) {
  const flags = parseFlags(args);
  const [oldName, newName] = flags._;
  if (!oldName || !newName) die(`Usage: ${bold("cvx rename <old> <new>")}`);
  const accounts = readAccounts();
  // New target names must be safe; overwriting an existing (legacy) name with
  // --force is grandfathered, matching cmdAdd.
  if (!Object.hasOwn(accounts, newName)) requireValidName(newName);
  const acc = requireAccount(accounts, oldName);
  if (oldName === newName) return console.log(dim("Same name — nothing to do."));
  if (accounts[newName] && !flags.force)
    die(`Account ${bold(newName)} already exists. Use ${bold("--force")} to overwrite.`);

  let movedToken: string | undefined;
  if (acc.keychain) {
    // The secret is keyed by name in the OS keychain — re-store it under the
    // new name in the same platform keychain it already lives in.
    const tok = tokenOf(oldName, acc);
    if (tok == null) die(`Couldn't read ${bold(oldName)}'s token from the keychain.`);
    accounts[newName] = withTokenRecord(acc, makeTokenRecord(platformKeychain(), newName, tok));
    movedToken = tok;
  } else {
    accounts[newName] = acc; // file/dpapi records travel with the object
    movedToken = acc.token; // inline token if file-backed; dpapi resolves lazily below
  }
  delete accounts[oldName];
  writeAccounts(accounts);
  // Remove the old secret only now that the vault is committed — a failed
  // write must never leave a record pointing at an already-deleted secret.
  if (acc.keychain) warnIfSecretLeft(oldName, deleteToken(oldName, acc));

  const links = readLinks();
  let moved = 0;
  for (const p of Object.keys(links))
    if (links[p] === oldName) {
      links[p] = newName;
      moved++;
    }
  writeLinks(links);
  // DPAPI records keep their secret in `enc`, so decrypt via tokenOf — but
  // only when the renamed account is the active one (it spawns PowerShell).
  if (readActive() === oldName)
    writeActive(newName, movedToken ?? tokenOf(newName, accounts[newName]) ?? undefined);

  console.log(
    `${green("✓")} Renamed ${bold(oldName)} → ${accountColor(newName)}${moved ? dim(` (${moved} link(s) updated)`) : ""}${vexTag("happy", newName)}`,
  );
}

export async function cmdRm(args: string[]) {
  const flags = parseFlags(args);
  const name = flags._[0];
  if (!name) die(`Usage: ${bold("cvx rm <account>")}`);
  const accounts = readAccounts();
  const acc = requireAccount(accounts, name);
  const nLinks = Object.values(readLinks()).filter((a) => a === name).length;
  // Confirm on a real terminal (skip with --force/--yes); piped/scripted
  // callers keep the old immediate behavior.
  if (process.stdin.isTTY && !flags.force && !flags.yes) {
    const yn = await ask(
      `Remove account ${accountColor(name)}${nLinks ? ` and its ${nLinks} link(s)` : ""}? [y/N] `,
    );
    if (!/^y(es)?$/i.test(yn)) return console.log(dim("Cancelled — nothing removed."));
  }
  delete accounts[name];
  writeAccounts(accounts);
  // Remove the OS-keychain secret (if any) only after the vault commit, so a
  // failed write can't leave a record pointing at a deleted secret.
  warnIfSecretLeft(name, deleteToken(name, acc));
  if (readActive() === name) clearActive();

  const links = readLinks();
  let removed = 0;
  for (const [p, a] of Object.entries(links))
    if (a === name) {
      delete links[p];
      removed++;
    }
  writeLinks(links);
  console.log(
    `${green("✓")} Removed account ${bold(name)}${removed ? dim(` (and ${removed} link(s))`) : ""} ${dim("· cvx undo restores it")}${vexTag("sad")}`,
  );
}

// --- email / reset / enable / disable ----------------------------------------

/**
 * email — label an account with the email it belongs to. A label only: Convex's
 * profile API rejects CLI tokens (WorkOSSessionRequired), so it can't be fetched.
 * Bare `cvx email <account>` prints the stored address (scripting-friendly).
 */
export function cmdEmail(args: string[]) {
  const flags = parseFlags(args);
  const name = flags._[0];
  if (!name) die(`Usage: ${bold("cvx email <account> [address]")}   (--clear removes it)`);
  const accounts = readAccounts();
  const acc = requireAccount(accounts, name);
  if (flags.clear) {
    delete acc.email;
    writeAccounts(accounts);
    return console.log(`${green("✓")} Cleared the email on ${accountColor(name)}.${vexTag("blink", name)}`);
  }
  const addr = flags._[1] ?? (typeof flags.email === "string" ? flags.email : undefined);
  if (!addr) return console.log(acc.email ?? "");
  acc.email = addr;
  writeAccounts(accounts);
  console.log(`${green("✓")} ${accountColor(name)} → ${addr}${vexTag("happy", name)}`);
}

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

// --- activate (the hot path) + interactive use ------------------------------

/**
 * activate — called by the shell hook on every cd. Must NEVER throw and break
 * the prompt. For inline (file) tokens it compares tokens directly; for
 * keychain/DPAPI tokens (a slow lookup) it trusts the active-marker so the hot
 * path stays fast.
 *
 * --env: additionally print ONE eval-able line to stdout binding this shell
 * session's account via CONVEX_OVERRIDE_ACCESS_TOKEN (+ CVX_ACCOUNT), which
 * the Convex CLI reads above the global config — that's what lets parallel
 * terminals hold different accounts. In this mode stdout belongs to the shell
 * hook's eval, so every human message goes to stderr instead; when no token
 * is available the line unsets both vars and the session falls back to the
 * global config (which is still swapped as before).
 */
export function cmdActivate(args: string[]) {
  const flags = parseFlags(args);
  const quiet = flags.q || flags.quiet;
  const envMode = !!flags.env;
  const shell: Shell = SHELLS.includes(flags.shell as Shell) ? (flags.shell as Shell) : "zsh";
  const say = envMode ? console.error : console.log;
  // Exactly one env line per invocation, whichever exit path runs.
  let envDone = false;
  const emit = (acct?: { name: string; token: string }) => {
    if (!envMode || envDone) return;
    envDone = true;
    console.log(envLine(shell, acct));
  };
  try {
    // Parked (`cvx disable`): touch nothing, and unset this session's vars so
    // a disabled cvx can't keep a token pinned in the shell.
    if (readConfig().disabled) {
      if (!quiet) say(dim("cvx is disabled — run `cvx enable` to resume switching."));
      return emit();
    }
    const link = resolveLink(flags._[0] ?? process.cwd());
    if (!link) {
      if (!quiet) say(dim("No account linked to this directory."));
      return emit();
    }
    const accounts = readAccounts();
    const acc = accounts[link.account];
    if (!acc) {
      if (!quiet) say(yellow(`Linked to unknown account "${link.account}".`));
      return emit();
    }
    warnTeamMismatch(flags._[0] ?? process.cwd(), link.account, acc, say);
    const expensive = !!acc.keychain || !!acc.enc; // reading the token spawns a process
    if (expensive) {
      // Trust the marker instead of a slow secret lookup — but only when its
      // token fingerprint still matches the global config, so an external
      // `npx convex login` can't leave the wrong account silently "active".
      // The matching global token IS this account's token — export that.
      const cur = currentConvexToken();
      if (cur != null && activeMarkerMatches(link.account, cur)) {
        if (!quiet)
          say(`${green("●")} ${accountColor(link.account)} ${teamLabel(acc)} ${dim("(already active)")}`);
        return emit({ name: link.account, token: cur });
      }
    }
    const token = tokenOf(link.account, acc);
    if (token == null) {
      // A locked vault must be visible even from the quiet cd-hook, or the
      // account silently never switches.
      if (acc.pw && vaultLocked()) {
        say(
          `${yellow("⚿")} vault locked — run ${bold("cvx vault unlock")} to switch to ${bold(link.account)}`,
        );
        return emit();
      }
      if (!quiet) console.error(red("cvx: ") + `couldn't read the token for ${link.account}`);
      return emit();
    }
    if (currentConvexToken() === token) {
      writeActive(link.account, token);
      if (!quiet)
        say(`${green("●")} ${accountColor(link.account)} ${teamLabel(acc)} ${dim("(already active)")}`);
      return emit({ name: link.account, token });
    }
    setConvexToken(token);
    writeActive(link.account, token);
    say(
      `${cyan("⇄")} convex account → ${accountColor(link.account)} ${teamLabel(acc)}${vexTag("happy", link.account)}`,
    );
    emit({ name: link.account, token });
  } catch (e) {
    if (!quiet) console.error(red("cvx: ") + (e as Error).message);
    emit(); // never leave the session bound to a stale token
  }
}

/** Activate an account globally by name (no link involved). */
function activateByName(name: string, acc: Account) {
  const token = tokenOf(name, acc);
  if (token == null) {
    if (acc.pw && vaultLocked()) die(`Vault locked — run ${bold("cvx vault unlock")} first.`);
    die(`Couldn't read the token for ${bold(name)}.`);
  }
  setConvexToken(token);
  writeActive(name, token);
  console.log(
    `${cyan("⇄")} convex account → ${accountColor(name)} ${teamLabel(acc)}${vexTag("happy", name)}`,
  );
}

/**
 * use — `cvx use <account>` activates that account by name from anywhere.
 * With a path (or nothing): activate the dir's linked account, else pick
 * interactively. A name wins over a same-named directory; use ./dir to force
 * the path meaning.
 */
export async function cmdUse(args: string[]) {
  const flags = parseFlags(args);
  const arg = flags._[0];
  const accounts = readAccounts();
  if (arg && Object.hasOwn(accounts, arg)) return activateByName(arg, accounts[arg]);
  if (resolveLink(arg ?? process.cwd())) return cmdActivate(args);

  const names = Object.keys(accounts);
  if (!names.length) die("No accounts yet. Run `cvx login <name>` first.");
  if (!process.stdin.isTTY)
    die(
      `This directory isn't linked to an account.\n  Run ${bold("cvx link <account>")} — or ${bold("cvx use")} in an interactive terminal to pick one.`,
    );

  // Auto-link offer: if this dir's deployment team uniquely identifies a stored
  // account, offer to activate + link it before falling back to the picker.
  const detected = projectEnv(process.cwd()).team;
  if (detected) {
    const matches = names.filter((n) => accounts[n].teams.some((t) => t.slug === detected));
    if (matches.length === 1) {
      const name = matches[0];
      const yn = await ask(
        `Detected team ${bold(detected)} → account ${accountColor(name)}. Activate and link this directory? [Y/n] `,
      );
      if (yn === "" || /^y(es)?$/i.test(yn)) {
        activateByName(name, accounts[name]);
        const here = canon(process.cwd());
        const links = readLinks();
        links[here] = name;
        writeLinks(links);
        console.log(
          `${green("✓")} Linked ${bold(shortPath(here))} → ${accountColor(name)} ${dim("— auto-switches from now on.")}`,
        );
        return;
      }
    }
  }

  // fzf when available, numbered fallback otherwise. An fzf cancel (Esc /
  // Ctrl-C) cancels the command — it must not fall through to the other picker.
  const chosen = hasCommand("fzf") ? pickWithFzf(names) : await pickNumbered(names);
  if (!chosen) return console.log(dim("Cancelled."));
  activateByName(chosen, accounts[chosen]);

  const here = canon(process.cwd());
  const yn = await ask(dim(`Link ${shortPath(here)} to ${chosen}? [y/N] `));
  if (/^y(es)?$/i.test(yn)) {
    const links = readLinks();
    links[here] = chosen;
    writeLinks(links);
    console.log(`${green("✓")} Linked — it'll switch automatically from now on.`);
  }
}

function pickWithFzf(names: string[]): string | null {
  const r = spawnSync("fzf", ["--height=40%", "--reverse", "--prompt", "account> "], {
    input: names.join("\n"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (r.error || r.status !== 0) return null; // cancelled (or fzf failed)
  return (r.stdout || "").trim() || null;
}

async function pickNumbered(names: string[]): Promise<string | null> {
  console.log(bold("Pick an account to activate:"));
  names.forEach((n, i) => console.log(`  ${cyan(String(i + 1))}  ${n}`));
  const answer = await ask("> ");
  const idx = Number.parseInt(answer, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > names.length) return null;
  return names[idx - 1];
}

// --- status / accounts / ls / which / prompt --------------------------------

export function cmdStatus(args: string[] = []) {
  const flags = parseFlags(args);
  const disabled = !!readConfig().disabled;
  const accounts = readAccounts();
  const global = activeAccountName(accounts);
  // A hooked shell exports the account per session (activate --env) — that's
  // what the Convex CLI actually uses here, so it wins over the global config.
  const session = sessionAccount(accounts);
  const active = session ?? global;
  const link = resolveLink(process.cwd());
  const loggedIn = currentConvexToken() != null;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          active,
          activeTeams: active ? accounts[active]?.teams.map((t) => t.slug) : [],
          session,
          global,
          linked: link?.account ?? null,
          linkPath: link?.path ?? null,
          dir: canon(process.cwd()),
          loggedIn,
          disabled,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Locked first: a locked vault makes every token unreadable, so `active`
  // is always null while locked — sleepy must win over curious.
  const mood: VexMood = vaultLocked()
    ? "sleepy"
    : !active
      ? "curious"
      : link && accounts[link.account] && mismatchedTeam(process.cwd(), accounts[link.account])
        ? "alarm"
        : "happy";
  const face = process.stdout.isTTY ? `   ${vex(mood, active)}` : "";
  if (disabled)
    console.log(yellow("cvx is disabled") + dim(" — the cd hook won't switch accounts (cvx enable resumes).") + "\n");
  console.log(bold("Active convex account:") + face);
  if (active) {
    const via =
      session && session !== global
        ? dim(`  (this session · global config: ${global ?? "none"})`)
        : "";
    console.log(`  ${green("●")} ${accountColor(active)} ${teamLabel(accounts[active])}${via}`);
  } else if (loggedIn)
    console.log(`  ${yellow("●")} unknown login ${dim("(run `cvx add <name>` to name it)")}`);
  else console.log(`  ${dim("(not logged in)")}`);

  console.log(bold("\nThis directory:"));
  if (link)
    console.log(
      `  linked to ${bold(link.account)}${
        link.path !== canon(process.cwd()) ? dim(`  (via ${shortPath(link.path)})`) : ""
      }`,
    );
  else console.log(dim("  not linked"));
  if (link && accounts[link.account])
    warnTeamMismatch(process.cwd(), link.account, accounts[link.account]);
}

export function cmdAccounts(args: string[] = []) {
  const flags = parseFlags(args);
  const accounts = readAccounts();
  const names = Object.keys(accounts);
  if (flags.names) {
    // machine-readable, for shell completion — bare names, one per line.
    for (const n of names) console.log(n);
    return;
  }
  if (!names.length)
    return console.log(dim("No accounts yet. Run `cvx login <name>` or `cvx add`."));
  const active = activeAccountName(accounts);
  console.log(bold("Accounts:"));
  for (const [name, acc] of Object.entries(accounts)) {
    const dot = name === active ? green("●") : dim("○");
    const store = acc.keychain ? dim("· keychain") : acc.enc || acc.pw ? dim("· encrypted") : "";
    const age = ago(acc.verifiedAt);
    const email = acc.email ? dim(` · ${acc.email}`) : "";
    console.log(
      `  ${dot} ${accountColor(name, name.padEnd(14))} ${teamLabel(acc)}${email} ${store}${age ? dim(` · verified ${age}`) : ""}`,
    );
  }
}

export function cmdLs() {
  const links = readLinks();
  const entries = Object.entries(links);
  if (!entries.length)
    return console.log(dim("No projects linked yet. Run `cvx link <account>` in a project."));
  const here = canon(process.cwd());
  console.log(bold("Linked projects:"));
  for (const [path, account] of entries.sort()) {
    const marker = path === here ? cyan("→") : " ";
    console.log(`  ${marker} ${accountColor(account, account.padEnd(14))} ${shortPath(path)}`);
  }
}

export function cmdWhich(args: string[]) {
  const link = resolveLink(args[0] ?? process.cwd());
  if (!link) {
    console.log("");
    process.exit(1);
  }
  console.log(link.account);
}

/** prompt — fast, no-network, prints the active account name (for a shell prompt). */
export function cmdPrompt(args: string[] = []) {
  const flags = parseFlags(args);
  if (flags.starship) {
    // Ready-to-paste starship config; starship shows the segment only when
    // `cvx prompt` prints something (i.e. an account is active).
    process.stdout.write(`# Add to ~/.config/starship.toml — shows the active Convex account.
[custom.cvx]
command = "cvx prompt"
when = "cvx prompt"
symbol = "\u21c4 "
format = "[$symbol$output]($style) "
style = "bold cyan"
`);
    return;
  }
  try {
    if (readConfig().disabled) return; // parked — show nothing in the prompt
    const accounts = readAccounts();
    // The session's own export (activate --env) is what convex actually uses
    // in this terminal — show it over the shared global marker.
    const name = sessionAccount(accounts) ?? readActive();
    if (name && accounts[name]) {
      // --color embeds raw ANSI in the account's stable color — an explicit
      // opt-in exception to output hygiene, for hand-rolled PS1/PROMPT use.
      if (flags.color) process.stdout.write(`\x1b[1;38;5;${accountColorCode(name)}m${name}\x1b[0m`);
      else process.stdout.write(name);
    }
  } catch {
    /* a prompt segment must never error */
  }
}

// --- run (per-command account, no global change) ----------------------------

/** run <account> [--] <command…> — run a command as an account without switching. */
export function cmdRun(args: string[]) {
  if (!args.length)
    die(`Usage: ${bold("cvx run <account> -- <command…>")}   (account "." = this dir's account)`);

  let account: string | null;
  let rest: string[];
  if (args[0] === "--") {
    account = null;
    rest = args.slice(1);
  } else {
    account = args[0] === "." ? null : args[0];
    rest = args[1] === "--" ? args.slice(2) : args.slice(1);
  }

  if (account === null) {
    const link = resolveLink(process.cwd());
    if (!link) die("This directory isn't linked. Give an account: `cvx run <account> -- <cmd>`.");
    account = link.account;
  }
  if (!rest.length) die(`No command given. Usage: ${bold("cvx run <account> -- <command…>")}`);

  const accounts = readAccounts();
  const acc = requireAccount(accounts, account);
  const token = tokenOf(account, acc);
  if (token == null) die(`Couldn't read the token for ${bold(account)}.`);

  const [cmd, ...cmdArgs] = rest;
  // runInherit resolves .cmd shims itself and never lets cmd.exe re-split
  // argv — spaced/quoted arguments survive on Windows (see system.ts).
  const r = runInherit(cmd, cmdArgs, { ...process.env, CONVEX_OVERRIDE_ACCESS_TOKEN: token });
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") die(`Command not found: ${bold(cmd)}`);
    die(`Could not run ${bold(cmd)}: ${err.message}`);
  }
  process.exit(r.status ?? 1);
}

// --- open (dashboard) -------------------------------------------------------

export function cmdOpen(args: string[] = []) {
  const dep = projectDeployment(args[0] ?? process.cwd());
  const url = dep
    ? `https://dashboard.convex.dev/d/${dep}`
    : "https://dashboard.convex.dev";
  console.log(
    dim(dep ? `Opening the Convex dashboard for ${dep}…` : "No CONVEX_DEPLOYMENT here — opening the Convex dashboard…"),
  );
  if (!openUrl(url)) die(`Couldn't open a browser. Visit: ${cyan(url)}`);
}

// --- scan (auto-link discovery) ---------------------------------------------

/** Does this dir's OWN .env.local declare a CONVEX_DEPLOYMENT? (No walk-up —
 *  projectEnv walks up, so we gate on the file living right here first.) */
function isProjectDir(dir: string): boolean {
  const envFile = join(dir, ".env.local");
  if (!existsSync(envFile)) return false;
  try {
    return readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .some((l) => /^\s*CONVEX_DEPLOYMENT\s*=/.test(l));
  } catch {
    return false;
  }
}

/**
 * Collect project dirs under `root` (up to `maxDepth` levels deep), skipping
 * hidden dirs and node_modules and never descending into a dir that is itself a
 * project. Symlinked dirs are skipped (isDirectory() is false for them), so the
 * walk can't loop.
 */
function findProjects(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (isProjectDir(dir)) {
      out.push(dir);
      return; // a project is a leaf — don't descend into it
    }
    if (depth <= 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(join(dir, e.name), depth - 1);
    }
  };
  walk(root, maxDepth);
  return out;
}

/** scan [dir] — discover Convex projects and propose account links by team. */
export async function cmdScan(args: string[]) {
  const flags = parseFlags(args);
  const accounts = readAccounts();
  const names = Object.keys(accounts);
  if (!names.length)
    die(
      `No accounts stored yet — nothing to match projects against.\n` +
        `  Add one first: ${bold("cvx login <name>")}, then re-run ${bold("cvx scan")}.`,
    );

  const input = flags._[0] ?? process.cwd();
  const root = resolve(input);
  if (!existsSync(root) || !statSync(root).isDirectory()) die(`Not a directory: ${input}`);

  let depth = 4;
  if (typeof flags.depth === "string") {
    const n = Number.parseInt(flags.depth, 10);
    if (Number.isFinite(n) && n >= 0) depth = n;
  }

  const links = readLinks();
  const proposals: Array<{ dir: string; account: string }> = [];
  const skips: string[] = [];
  let already = 0;

  for (const dir of findProjects(root, depth)) {
    const team = projectEnv(dir).team;
    if (!team) {
      skips.push(`  ${dim("•")} ${shortPath(dir)} ${dim("— no team note, skipped")}`);
      continue;
    }
    const matches = names.filter((n) => accounts[n].teams.some((t) => t.slug === team));
    if (matches.length === 0) {
      skips.push(`  ${yellow("•")} ${shortPath(dir)} ${dim("— no account for team")} ${bold(team)}`);
      continue;
    }
    if (matches.length > 1) {
      skips.push(
        `  ${yellow("•")} ${shortPath(dir)} ${dim(`— team ${team} matches ${matches.length} accounts, skipped`)}`,
      );
      continue;
    }
    const account = matches[0];
    const linked = links[canon(dir)];
    if (linked === account) {
      already++;
      continue;
    }
    if (linked) {
      skips.push(
        `  ${yellow("•")} ${shortPath(dir)} ${dim(`— already linked to ${linked} (team wants ${account}), left as-is`)}`,
      );
      continue;
    }
    proposals.push({ dir, account });
  }

  if (skips.length) {
    console.log(bold("Skipped:"));
    for (const s of skips) console.log(s);
  }

  let linked = 0;
  if (proposals.length) {
    console.log(bold(`${skips.length ? "\n" : ""}Proposed links:`));
    const w = Math.max(...proposals.map((p) => p.account.length));
    for (const p of proposals)
      console.log(`  ${accountColor(p.account, p.account.padEnd(w))}  ${shortPath(p.dir)}`);

    let proceed: boolean;
    if (flags.yes) {
      proceed = true;
    } else if (process.stdin.isTTY) {
      const yn = await ask(`\nLink ${proposals.length} project(s)? [Y/n] `);
      proceed = yn === "" || /^y(es)?$/i.test(yn);
    } else {
      console.log(dim(`\nRe-run with ${bold("--yes")} to apply these links.`));
      die("Refusing to link without confirmation on a non-interactive terminal.");
    }

    if (!proceed) {
      console.log(dim("Cancelled — nothing linked."));
      return;
    }
    for (const p of proposals) links[canon(p.dir)] = p.account;
    writeLinks(links); // one write for the whole batch
    linked = proposals.length;
  }

  console.log(
    `${green("✓")} ${dim("scan:")} linked ${bold(String(linked))}, already ${bold(String(already))}, skipped ${bold(String(skips.length))}.${vexTag(linked ? "happy" : "curious")}`,
  );
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
  const curAccounts = raw(join(VAULT, "accounts.json"));
  const curLinks = raw(join(VAULT, "links.json"));

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
  if (b.accounts?.includes('"keychain": true'))
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

// --- version / doctor -------------------------------------------------------

export function cmdVersion() {
  console.log(VERSION);
}

/** Health check: node/npx, Convex login, vault, storage backend, tokens, hook. */
export async function cmdDoctor(args: string[] = []) {
  const flags = parseFlags(args);
  const mark = (b: boolean) => (b ? green("✓") : red("✗"));
  const warn = (b: boolean) => (b ? green("✓") : yellow("!"));
  let healthy = true;
  console.log(bold("cvx doctor") + "\n");

  const npx = hasCommand("npx");
  if (!npx) healthy = false;
  console.log(
    `  ${mark(npx)} node / npx        ${npx ? dim("available") : yellow("missing — needed for `cvx login`")}`,
  );

  const tok = currentConvexToken();
  console.log(
    `  ${warn(!!tok)} convex login      ${tok ? dim("~/.convex/config.json present") : yellow("none yet — run `cvx login <name>`")}`,
  );

  let accounts: Accounts = {};
  let nLink = 0;
  let vaultOk = true; // accounts.json parses
  let linksOk = true; // links.json parses (report separately — accounts may be fine)
  try {
    accounts = readAccounts();
  } catch {
    vaultOk = false;
    healthy = false;
  }
  try {
    nLink = Object.keys(readLinks()).length;
  } catch {
    linksOk = false;
    healthy = false;
  }
  const nAcc = Object.keys(accounts).length;
  console.log(
    `  ${mark(vaultOk && linksOk)} vault             ${
      vaultOk && linksOk
        ? dim(`${nAcc} account(s), ${nLink} link(s)  ·  ~/.convex-switch`)
        : red(`${vaultOk ? "links.json" : "accounts.json"} corrupted — see ~/.convex-switch`)
    }`,
  );

  const backend = storageBackend();
  const lockNote =
    backend === "passphrase" ? (vaultLocked() ? yellow(" · locked — run `cvx vault unlock`") : dim(" · unlocked")) : "";
  console.log(`  ${green("✓")} token storage     ${dim(backendLabel(backend))}${lockNote}`);

  const active = vaultOk ? activeAccountName(accounts) : null;
  const activeEmail = active && accounts[active]?.email ? ` · ${accounts[active].email}` : "";
  console.log(
    `  ${warn(!!active)} active account    ${active ? dim(active + activeEmail) : dim("none active")}`,
  );

  if (readConfig().disabled)
    console.log(`  ${yellow("!")} disabled          ${yellow("cvx is paused — run `cvx enable` to resume switching")}`);

  // Hook presence AND freshness: an rc still carrying an older snippet keeps
  // the old cd-only behavior even after the binary upgrades — flag it.
  let hooked = false;
  const staleHooks: Exclude<Shell, "powershell">[] = [];
  for (const [sh, f] of Object.entries(RC_FILES) as [Exclude<Shell, "powershell">, string][]) {
    const rc = join(HOME, f);
    if (!existsSync(rc)) continue;
    const body = readFileSync(rc, "utf8");
    if (!body.includes(HOOK_MARKER)) continue;
    hooked = true;
    const swapped = replaceHookBlock(body, hookFor(sh));
    if (!swapped || swapped.changed) staleHooks.push(sh);
  }
  // PowerShell's profile has no fixed RC_FILES path — check it separately when
  // it's this machine's shell, or an installed pwsh hook is invisible here.
  let pwshStale = false;
  if (detectShell() === "powershell") {
    const profile = pwshProfilePath();
    if (profile && existsSync(profile)) {
      const body = readFileSync(profile, "utf8");
      if (body.includes(HOOK_MARKER)) {
        hooked = true;
        const swapped = replaceHookBlock(body, hookFor("powershell"));
        if (!swapped || swapped.changed) pwshStale = true;
      }
    }
  }
  const anyStale = staleHooks.length > 0 || pwshStale;
  console.log(
    `  ${warn(hooked && !anyStale)} shell hook        ${
      hooked
        ? anyStale
          ? yellow("outdated — run `cvx hook --install` (or `cvx doctor --fix`)")
          : dim("installed")
        : yellow("not installed — run `cvx hook --install`")
    }`,
  );

  // Token health — pings Convex for each account (skip with --no-tokens).
  const tokenChecks = vaultOk && !!nAcc && !flags["no-tokens"];
  const rejected: string[] = []; // tokens Convex refused (not merely offline)
  if (tokenChecks) {
    console.log(bold("\nToken health:"));
    let verifiedAny = false;
    for (const [name, acc] of Object.entries(accounts)) {
      const email = acc.email ? dim(` · ${acc.email}`) : "";
      const t = tokenOf(name, acc);
      if (t == null) {
        console.log(`  ${red("✗")} ${bold(name.padEnd(14))} ${red("token unreadable")}${email}`);
        healthy = false;
        continue;
      }
      const sp = spin(`  checking ${name}…`);
      try {
        const teams = await verifyToken(t);
        const age = ago(acc.verifiedAt);
        sp.stop(
          `  ${green("✓")} ${accountColor(name, name.padEnd(14))} ${dim("valid")}${email}${age ? dim(` · last verified ${age}`) : ""}`,
        );
        // Teams get renamed/added on Convex's side; the vault only knows what
        // it saw at `add` time. Take the fresh list so the team-mismatch guard
        // stops firing on a slug that no longer exists.
        const before = acc.teams.map((x) => x.slug).join(", ");
        const after = teams.map((x) => x.slug).join(", ");
        if (before !== after) console.log(dim(`      teams: ${before || "(none)"} → ${after || "(none)"}`));
        acc.teams = teams;
        acc.verifiedAt = new Date().toISOString();
        verifiedAny = true;
      } catch (e) {
        const msg = String((e as Error).message);
        const offline = /reach Convex|timed out/.test(msg);
        sp.stop(
          `  ${offline ? yellow("!") : red("✗")} ${bold(name.padEnd(14))} ${offline ? dim("couldn't check (offline)") : red(msg)}${email}`,
        );
        if (!offline) {
          // With --fix we offer to re-auth below, so defer the verdict; without
          // it, this is an unfixed problem right now.
          rejected.push(name);
          if (!flags.fix) {
            healthy = false;
            console.log(dim(`      → re-authenticate with  cvx refresh ${name}`));
          }
        }
      }
    }
    if (verifiedAny) writeAccounts(accounts); // persist fresh verifiedAt stamps
  }

  // --fix: apply repairs. Fixed problems no longer force a non-zero exit;
  // unfixed real problems still do.
  if (flags.fix) {
    console.log(bold("\nApplying fixes:"));
    let fixedAny = false;
    const fixed = (msg: string) => {
      fixedAny = true;
      console.log(`  ${green("↳")} fixed: ${msg}`);
    };

    // Shell hook missing → install it for the detected shell.
    // Present but outdated → swap the block for the current snippet.
    if (!hooked) {
      const shell = detectShell();
      if (shell === "powershell") {
        const r = installPwsh(hookFor("powershell"));
        if (r === "added" || r === "updated") fixed("installed the PowerShell cd-hook");
      } else if (installHookInto(shell) === "added") {
        fixed(`installed the ${shell} cd-hook into ${shortPath(join(HOME, RC_FILES[shell]))}`);
      }
    } else {
      for (const sh of staleHooks) {
        const r = installHookInto(sh);
        if (r === "updated") fixed(`updated the ${sh} hook in ${shortPath(join(HOME, RC_FILES[sh]))}`);
        else if (r === "manual")
          console.log(
            dim(`      → the ${sh} hook block in ${shortPath(join(HOME, RC_FILES[sh]))} is incomplete — reinstall it by hand (cvx hook)`),
          );
      }
      if (pwshStale && installPwsh(hookFor("powershell")) === "updated")
        fixed("updated the PowerShell hook");
    }

    // Dead links → prune every links.json path that no longer exists (one write).
    if (linksOk) {
      const links = readLinks();
      const dead = Object.keys(links).filter((p) => !existsSync(p));
      if (dead.length) {
        for (const p of dead) delete links[p];
        writeLinks(links);
        for (const p of dead) fixed(`pruned dead link ${shortPath(p)}`);
      }
    }

    // Stale active marker → the named account is gone; clear it.
    const marked = readActive();
    if (vaultOk && marked && !accounts[marked]) {
      clearActive();
      fixed(`cleared stale active marker (${marked})`);
    }

    // Dead tokens → offer a per-account re-auth (only when token checks ran).
    for (const name of rejected) {
      if (process.stdin.isTTY) {
        const yn = await ask(`Re-authenticate ${bold(name)} now? [y/N] `);
        if (/^y(es)?$/i.test(yn)) {
          await loginAndStore(name, `Re-authenticating ${bold(name)} — sign into that account in the browser…`);
          fixed(`re-authenticated ${name}`);
          continue;
        }
      } else {
        console.log(dim(`      → re-authenticate with  cvx refresh ${name}`));
      }
      healthy = false; // declined or non-interactive — still a live problem
    }

    if (!fixedAny) console.log(dim("  nothing to fix."));
  }

  console.log();
  console.log(
    healthy
      ? green("Everything looks good.") +
          (process.stdout.isTTY ? "  " + dim("~ Vex approves ") + vex("wink") + dim(" ~") : "")
      : yellow("Some checks need attention (see above)."),
  );
  if (!healthy) process.exitCode = 1;
}

// --- completions ------------------------------------------------------------

export function cmdCompletions(args: string[]) {
  const shell = parseFlags(args)._[0] || detectShell();
  const script = completionFor(shell);
  if (!script) {
    if (shell === "nu") die("Nushell completions aren't available yet (the cd-hook works: `cvx hook --shell nu`).");
    die(`Usage: ${bold("cvx completions <zsh|bash|fish|powershell>")}`);
  }
  process.stdout.write(script);
}

// --- hook -------------------------------------------------------------------

export function cmdHook(args: string[]) {
  const flags = parseFlags(args);
  const shell = ((flags.shell as Shell) || detectShell()) as Shell;
  if (!SHELLS.includes(shell))
    die(`Unknown shell ${bold(String(shell))}. Use --shell ${SHELLS.join("|")}.`);
  const snippet = hookFor(shell);

  if (!flags.install) {
    process.stdout.write(snippet);
    return;
  }
  if (shell === "powershell") return installPwsh(snippet);

  const rc = join(HOME, RC_FILES[shell]);
  switch (installHookInto(shell)) {
    case "added":
      console.log(`${green("✓")} Added hook to ${cyan(shortPath(rc))}.${vexTag("happy")}`);
      console.log(dim(`  Open a new terminal to activate it.`));
      break;
    case "updated":
      console.log(`${green("✓")} Updated the hook in ${cyan(shortPath(rc))}.${vexTag("happy")}`);
      console.log(dim(`  Open a new terminal to pick up the new version.`));
      break;
    case "unchanged":
      console.log(yellow(`Hook already up to date in ${shortPath(rc)} — nothing to do.`));
      break;
    case "manual":
      console.log(
        yellow(`Found a ${HOOK_MARKER} marker in ${shortPath(rc)} but not a complete hook block.`) +
          `\n  Remove the old lines, then re-run ${bold("cvx hook --install")} (or paste ${bold("cvx hook")}'s output).`,
      );
  }
}

type InstallResult = "added" | "updated" | "unchanged" | "manual";

/**
 * Write the cd-hook into `shell`'s rc file: appended when absent, swapped in
 * place when an older block is installed (so binary upgrades can ship hook
 * fixes), left alone when already current. "manual" = a marker is present but
 * the block is incomplete (hand-edited) — never rewrite those. Shared by
 * `cvx hook --install` and `doctor --fix` (powershell has no fixed rc path —
 * it uses installPwsh instead).
 */
function installHookInto(shell: Exclude<Shell, "powershell">): InstallResult {
  const rc = join(HOME, RC_FILES[shell]);
  const body = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (body.includes(HOOK_MARKER)) {
    const swapped = replaceHookBlock(body, hookFor(shell));
    if (!swapped) return "manual";
    if (!swapped.changed) return "unchanged";
    writeFileSync(rc, swapped.body);
    return "updated";
  }
  mkdirSync(dirname(rc), { recursive: true });
  appendFileSync(rc, "\n" + hookFor(shell));
  return "added";
}

/**
 * The PowerShell profile the hook lives in. CVX_HOME is a complete sandbox —
 * it must relocate this file too, never spawn the real pwsh to resolve (and
 * later overwrite) the machine's actual $PROFILE from a test or sandbox run.
 */
function pwshProfilePath(): string | null {
  if (process.env.CVX_HOME) return join(HOME, "powershell_profile.ps1");
  const ask2 = (exe: string) => {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], {
      encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  return ask2("pwsh") || ask2("powershell") || null;
}

function installPwsh(snippet: string): InstallResult | "missing" {
  const profile = pwshProfilePath();
  if (!profile) {
    console.log(yellow("Couldn't find PowerShell. Add this to your $PROFILE manually:") + "\n");
    process.stdout.write(snippet);
    return "missing";
  }
  const body = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (body.includes(HOOK_MARKER)) {
    const swapped = replaceHookBlock(body, snippet);
    if (swapped?.changed) {
      writeFileSync(profile, swapped.body);
      console.log(`${green("✓")} Updated the hook in ${cyan(profile)}.${vexTag("happy")}`);
      console.log(dim("  Open a new PowerShell window to pick up the new version."));
      return "updated";
    } else if (swapped) {
      console.log(yellow(`Hook already up to date in ${profile} — nothing to do.`));
      return "unchanged";
    } else {
      console.log(
        yellow(`Found a ${HOOK_MARKER} marker in ${profile} but not a complete hook block.`) +
          `\n  Remove the old lines, then re-run ${bold("cvx hook --install")}.`,
      );
      return "manual";
    }
  }
  mkdirSync(dirname(profile), { recursive: true });
  appendFileSync(profile, "\n" + snippet);
  console.log(`${green("✓")} Added hook to ${cyan(profile)}.${vexTag("happy")}`);
  console.log(dim("  Open a new PowerShell window to activate it."));
  return "added";
}
