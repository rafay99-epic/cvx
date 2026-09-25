/**
 * status — read-only views: status, accounts, ls, version.
 */

import {
  readAccounts,
  readLinks,
  readConfig,
  currentConvexToken,
  resolveLink,
  canon,
  shortPath,
  activeAccountName,
} from "../store";
import { vaultLocked } from "../vault";
import { bold, dim, green, yellow, cyan, teamLabel, accountColor, vex } from "../ui";
import { type VexMood } from "../vex";
import { VERSION } from "../version";
import { parseFlags } from "../args";
import { ago, mismatchedTeam, sessionAccount, warnTeamMismatch } from "./shared";

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
  // Same precedence as status: this terminal's session account wins.
  const active = sessionAccount(accounts) ?? activeAccountName(accounts);
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


export function cmdVersion() {
  console.log(VERSION);
}
