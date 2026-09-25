/**
 * links — binding projects to accounts and acting on the binding: link,
 * unlink, activate (the cd hot path), use, which, prompt, run, open, scan.
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { type Shell, isShell, envLine } from "../hooks";
import { hasCommand, openUrl, runInherit } from "../system";
import {
  type Account,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  readConfig,
  currentConvexToken,
  setConvexToken,
  resolveLink,
  canon,
  shortPath,
  tokenOf,
  readActive,
  writeActive,
  activeMarkerMatches,
  projectDeployment,
  projectEnv,
  readEnvLocal,
  ownsProject,
  type ProjectEnv,
} from "../store";
import { vaultLocked } from "../vault";
import { bold, dim, green, yellow, red, cyan, die, teamLabel, accountColor, vexTag } from "../ui";
import { spin } from "../spinner";
import { accountColorCode } from "../colors";
import { parseFlags } from "../args";
import { ask, findOwner, requireAccount, sessionAccount, warnTeamMismatch } from "./shared";

// --- link / unlink / rename / rm --------------------------------------------

export async function cmdLink(args: string[]) {
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

  // Confirm with Convex that this account owns the deployment. Remembering
  // it makes the cd-time guard rename-proof and offline.
  const env = projectEnv(target);
  if (!env.deployment) return;
  const label = "  Checking with Convex… ";
  const sp = spin(label);
  const owner = await findOwner(env, accounts, account);
  if (owner) writeAccounts(accounts);
  if (owner === account) return sp.stop(label + green("verified"));
  if (owner === undefined) return sp.stop(label + dim("couldn't check"));
  if (owner === null) {
    sp.stop(label + yellow("no stored account owns it"));
    console.log(
      dim(`  None of your accounts can see ${env.deployment}. Store the one that does: `) + bold("cvx login <name>"),
    );
    return;
  }
  sp.stop(label + yellow(`owned by ${owner}`));
  console.log(`${yellow("▲")} Convex says this project belongs to ${accountColor(owner)}, not ${bold(account)}.`);
  if (process.stdin.isTTY && /^(y(es)?)?$/i.test(await ask(`Link it to ${owner} instead? [Y/n] `))) {
    links[target] = owner;
    writeLinks(links);
    console.log(`${green("✓")} Linked ${bold(shortPath(target))} → ${accountColor(owner)}${vexTag("happy", owner)}`);
  } else console.log(dim(`  Fix later with: cvx link ${owner} ${shortPath(target)}`));
}

export function cmdUnlink(args: string[]) {
  const target = canon(args[0] ?? process.cwd());
  const links = readLinks();
  if (!links[target]) die(`No link at ${shortPath(target)}`);
  delete links[target];
  writeLinks(links);
  console.log(`${green("✓")} Unlinked ${bold(shortPath(target))}${vexTag("sad")}`);
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
  const shell: Shell = isShell(flags.shell) ? flags.shell : "zsh";
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
      if (!activeMarkerMatches(link.account, token)) writeActive(link.account, token);
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

  // Auto-link offer: if this project uniquely identifies a stored account
  // (offline first, then by asking Convex), offer to activate + link it
  // before falling back to the picker.
  const env = projectEnv(process.cwd());
  const matches = names.filter((n) => ownsProject(accounts[n], env) === true);
  let detected: string | null | undefined = matches.length === 1 ? matches[0] : undefined;
  if (detected === undefined && env.deployment) {
    const label = "Asking Convex who owns this project… ";
    const sp = spin(label);
    detected = await findOwner(env, accounts);
    sp.stop(label + (detected ? green(detected) : dim("no match")));
    if (detected) writeAccounts(accounts);
  }
  if (detected) {
    const name = detected;
    const yn = await ask(
      `This project belongs to ${accountColor(name)}${env.team ? dim(` (team ${env.team})`) : ""}. Activate and link this directory? [Y/n] `,
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

/**
 * Collect Convex projects (dirs whose own .env.local declares a
 * CONVEX_DEPLOYMENT) under `root`, up to `maxDepth` levels deep, skipping
 * hidden dirs and node_modules and never descending into a project. Symlinked
 * dirs are skipped (isDirectory() is false for them), so the walk can't loop.
 */
function findProjects(root: string, maxDepth: number): Array<{ dir: string; env: ProjectEnv }> {
  const out: Array<{ dir: string; env: ProjectEnv }> = [];
  const walk = (dir: string, depth: number) => {
    const env = readEnvLocal(dir);
    if (env) {
      out.push({ dir, env });
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

  const consider = (dir: string, account: string) => {
    const linked = links[canon(dir)];
    if (linked === account) already++;
    else if (linked)
      skips.push(
        `  ${yellow("•")} ${shortPath(dir)} ${dim(`— already linked to ${linked} (belongs to ${account}), left as-is`)}`,
      );
    else proposals.push({ dir, account });
  };

  // Offline matching first; anything it can't place is asked of Convex below.
  const unplaced: Array<{ dir: string; env: ProjectEnv; skip: string }> = [];
  for (const { dir, env } of findProjects(root, depth)) {
    const matches = names.filter((n) => ownsProject(accounts[n], env) === true);
    if (matches.length === 1) {
      consider(dir, matches[0]);
      continue;
    }
    const skip = !env.team
      ? `  ${dim("•")} ${shortPath(dir)} ${dim("— no team note, skipped")}`
      : matches.length > 1
        ? `  ${yellow("•")} ${shortPath(dir)} ${dim(`— team ${env.team} matches ${matches.length} accounts, skipped`)}`
        : `  ${yellow("•")} ${shortPath(dir)} ${dim("— no account for team")} ${bold(env.team)}`;
    if (env.deployment) unplaced.push({ dir, env, skip });
    else skips.push(skip);
  }

  if (unplaced.length) {
    const label = `Asking Convex about ${unplaced.length} project(s)… `;
    const sp = spin(label);
    let found = 0;
    for (let i = 0; i < unplaced.length; i += 4) {
      const batch = unplaced.slice(i, i + 4);
      const owners = await Promise.all(batch.map((u) => findOwner(u.env, accounts)));
      batch.forEach((u, j) => {
        const owner = owners[j];
        if (owner) {
          found++;
          consider(u.dir, owner);
        } else skips.push(u.skip);
      });
    }
    sp.stop(label + (found ? green(`${found} placed`) : dim("none placed")));
    if (found) writeAccounts(accounts); // remember the confirmed deployments
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
