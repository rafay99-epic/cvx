/**
 * shared — helpers used by more than one command module.
 */

import { createInterface } from "node:readline/promises";
import {
  type Account,
  type Accounts,
  tokenOf,
  validAccountName,
  projectEnv,
  ownsProject,
  deploymentOwner,
  type ProjectEnv,
} from "../store";
import { bold, dim, yellow, die } from "../ui";

// --- small helpers ----------------------------------------------------------

export function requireAccount(accounts: Accounts, name: string): Account {
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
export function sessionAccount(accounts: Accounts): string | null {
  const name = process.env.CVX_ACCOUNT;
  if (!process.env.CONVEX_OVERRIDE_ACCESS_TOKEN || !name) return null;
  return Object.hasOwn(accounts, name) ? name : null;
}

export function requireValidName(name: string) {
  if (!validAccountName(name))
    die(
      `Invalid account name ${bold(name)}.\n` +
        `  Use letters, digits, dots, dashes or underscores, starting with a letter or digit.`,
    );
}

/** "today" / "3d ago" from an ISO timestamp, or null when unknown. */
export function ago(iso?: string): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  return days === 0 ? "today" : `${days}d ago`;
}

/**
 * Wrong-account guard, offline: returns the project's team note when it names
 * a team this account isn't in (and no confirmed deployment says otherwise).
 * Such a project would deploy to a DIFFERENT account than the one being
 * activated — callers say so loudly, even in quiet (hook) mode.
 */
export function mismatchedTeam(dir: string, acc: Account): string | null {
  const env = projectEnv(dir);
  return ownsProject(acc, env) === false ? env.team : null;
}

export const isOffline = (e: unknown) => /reach Convex|timed out/.test((e as Error).message);

function rememberDeployment(acc: Account, dep: string) {
  if (!acc.deployments?.includes(dep)) acc.deployments = [...(acc.deployments ?? []), dep];
}

// Keychain/DPAPI reads spawn a process; doctor and scan ask about many
// projects, so read each account's token once. Keyed by the record, so a
// replaced record (a refresh) is read fresh.
const tokenCache = new WeakMap<Account, string | null>();
function cachedToken(name: string, acc: Account): string | null {
  if (!tokenCache.has(acc)) tokenCache.set(acc, tokenOf(name, acc));
  return tokenCache.get(acc) ?? null;
}

/**
 * Ask Convex which stored account owns this project's deployment, trying
 * `prefer` first. Network, so never on the cd hot path. The owner gets the
 * deployment recorded (the caller writes the vault), which makes every later
 * check offline. Returns the account name, null when no stored account can see
 * the deployment, or undefined when it couldn't be checked (no deployment,
 * offline, or every token rejected).
 */
export async function findOwner(
  env: ProjectEnv,
  accounts: Accounts,
  prefer?: string,
): Promise<string | null | undefined> {
  const dep = env.deployment;
  if (!dep) return undefined;
  const names = Object.keys(accounts).sort((a, b) => Number(b === prefer) - Number(a === prefer));
  let answered = false;
  for (const name of names) {
    const token = cachedToken(name, accounts[name]);
    if (token == null) continue;
    try {
      const owner = await deploymentOwner(token, dep);
      answered = true;
      if (owner) {
        rememberDeployment(accounts[name], dep);
        return name;
      }
    } catch (e) {
      if (isOffline(e)) return undefined;
      // This token was rejected; the other accounts may still answer.
    }
  }
  return answered ? null : undefined;
}

export function warnTeamMismatch(dir: string, name: string, acc: Account, say = console.log) {
  const team = mismatchedTeam(dir, acc);
  if (!team) return;
  say(
    `${yellow("▲")} team mismatch: this project's deployment belongs to ${bold(team)}, ` +
      `but ${bold(name)} only has ${acc.teams.map((t) => t.slug).join(", ")}.\n` +
      dim("  Linked to the wrong account? Fix with: cvx link <account>\n") +
      dim("  Team renamed on Convex? Run cvx doctor: it asks Convex and remembers the answer."),
  );
}

/** Warn (don't fail) when an account's OS-keychain secret couldn't be removed. */
export function warnIfSecretLeft(name: string, deleted: boolean) {
  if (!deleted)
    console.error(
      yellow("! ") +
        `couldn't remove ${bold(name)}'s secret from the OS keychain — ` +
        `delete the "convex-switch" entry for it manually.`,
    );
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
