/**
 * accounts — add, login, refresh, rename, rm, email: everything that creates
 * or edits a stored account.
 */

import { hasCommand, runInherit } from "../system";
import { backendLabel, deleteToken, platformKeychain } from "../keychain";
import {
  type Team,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  currentConvexToken,
  verifyToken,
  tokenOf,
  makeTokenRecord,
  withTokenRecord,
  validAccountName,
  storageBackend,
  readActive,
  writeActive,
  clearActive,
  mergeTeams,
  accountMeta,
} from "../store";
import { bold, dim, green, red, cyan, die, teamLabel, accountColor, vexTag } from "../ui";
import { spin } from "../spinner";
import { accountColorCode, nextAccountColor } from "../colors";
import { parseFlags } from "../args";
import { ask, requireAccount, requireValidName, warnIfSecretLeft } from "./shared";

// --- add / login ------------------------------------------------------------

export async function cmdAdd(args: string[]) {
  const flags = parseFlags(args);
  let name = flags._[0];
  if (flags.token === true) die(`${bold("--token")} needs a value: ${bold("cvx add <name> --token <token>")}`);
  let token = typeof flags.token === "string" ? flags.token : null;

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
  // Re-adding the same account (refresh) keeps its metadata and folds in the
  // fresh teams; overwriting with a different login starts clean.
  const prev = accounts[name];
  const same =
    !!prev && prev.teams.some((p) => teams.some((t) => (p.id != null && p.id === t.id) || p.slug === t.slug));
  // A refreshed account keeps the color it already wears; a new one takes the
  // first color no other account has.
  const others = Object.keys(accounts).filter((n) => n !== name);
  accounts[name] = {
    ...(same ? accountMeta(prev) : {}),
    color: same ? (prev.color ?? accountColorCode(name)) : nextAccountColor(others.map(accountColorCode)),
    ...rec,
    teams: same ? mergeTeams(prev.teams, teams) : teams,
    addedAt: prev?.addedAt ?? now,
    verifiedAt: now,
  };
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
export function loginAndStore(name: string, banner: string) {
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
