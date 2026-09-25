/**
 * doctor — setup and token health checks, with --fix repairs.
 */

import { existsSync, readFileSync } from "node:fs";
import { type Shell, hookFor, detectShell, HOOK_MARKER, RC_FILES, replaceHookBlock } from "../hooks";
import { hasCommand } from "../system";
import { backendLabel } from "../keychain";
import {
  type Account,
  type Accounts,
  type Team,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  readConfig,
  currentConvexToken,
  verifyToken,
  shortPath,
  tokenOf,
  storageBackend,
  readActive,
  clearActive,
  activeAccountName,
  projectEnv,
  mergeTeams,
} from "../store";
import { vaultLocked } from "../vault";
import { bold, dim, green, yellow, red, accountColor, vex } from "../ui";
import { spin } from "../spinner";
import { accountColorCode, isReservedColor, nextAccountColor } from "../colors";
import { parseFlags } from "../args";
import { loginAndStore } from "./accounts";
import { hookFile, installHook } from "./hook";
import { ago, ask, findOwner, isOffline } from "./shared";

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

  // Account colors: two accounts in one color (or one in alarm red / warning
  // yellow) defeats telling them apart at a glance. Cosmetic, so not unhealthy.
  const clashing = vaultOk ? colorClashes(accounts) : [];
  if (clashing.length)
    console.log(
      `  ${yellow("!")} account colors    ${yellow(`${clashing.join(", ")} ${clashing.length === 1 ? "looks" : "look"} like another account or a warning`)}` +
        (flags.fix ? "" : dim("  → cvx doctor --fix")),
    );

  const active = vaultOk ? activeAccountName(accounts) : null;
  const activeEmail = active && accounts[active]?.email ? ` · ${accounts[active].email}` : "";
  console.log(
    `  ${warn(!!active)} active account    ${active ? dim(active + activeEmail) : dim("none active")}`,
  );

  if (readConfig().disabled)
    console.log(`  ${yellow("!")} disabled          ${yellow("cvx is paused — run `cvx enable` to resume switching")}`);

  // Hook presence AND freshness: an rc still carrying an older snippet keeps
  // that snippet's behavior even after the binary upgrades — flag it.
  // PowerShell's profile has no fixed path, so it's only checked when it's
  // this machine's shell.
  const shells: Shell[] = [...(Object.keys(RC_FILES) as Shell[]), ...(detectShell() === "powershell" ? ["powershell" as const] : [])];
  let hooked = false;
  const staleHooks: Array<{ shell: Shell; file: string }> = [];
  for (const shell of shells) {
    const file = hookFile(shell);
    if (!file || !existsSync(file)) continue;
    const body = readFileSync(file, "utf8");
    if (!body.includes(HOOK_MARKER)) continue;
    hooked = true;
    const swapped = replaceHookBlock(body, hookFor(shell));
    if (!swapped || swapped.changed) staleHooks.push({ shell, file });
  }
  const anyStale = staleHooks.length > 0;
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
    // Every account at once: offline, a sequential loop waited 12 s per account.
    const entries = Object.entries(accounts);
    const label = `  checking ${entries.length} account(s)…`;
    const sp = spin(label);
    type Check = { name: string; acc: Account } & ({ teams: Team[] } | { error: Error } | { unreadable: true });
    const results = await Promise.all(
      entries.map(async ([name, acc]): Promise<Check> => {
        const t = tokenOf(name, acc);
        if (t == null) return { name, acc, unreadable: true as const };
        try {
          return { name, acc, teams: await verifyToken(t) };
        } catch (e) {
          return { name, acc, error: e as Error };
        }
      }),
    );
    sp.stop(dim(label + " done"));
    for (const r of results) {
      const { name, acc } = r;
      const email = acc.email ? dim(` · ${acc.email}`) : "";
      if ("unreadable" in r) {
        console.log(`  ${red("✗")} ${bold(name.padEnd(14))} ${red("token unreadable")}${email}`);
        healthy = false;
        continue;
      }
      if ("teams" in r) {
        const age = ago(acc.verifiedAt);
        console.log(
          `  ${green("✓")} ${accountColor(name, name.padEnd(14))} ${dim("valid")}${email}${age ? dim(` · last verified ${age}`) : ""}`,
        );
        // Teams get renamed/added on Convex's side; the vault only knows what
        // it saw at `add` time. Take the fresh list so the team-mismatch guard
        // stops firing on a slug that no longer exists.
        const before = acc.teams.map((x) => x.slug).join(", ");
        const after = r.teams.map((x) => x.slug).join(", ");
        if (before !== after) console.log(dim(`      teams: ${before || "(none)"} → ${after || "(none)"}`));
        acc.teams = mergeTeams(acc.teams, r.teams);
        acc.verifiedAt = new Date().toISOString();
        verifiedAny = true;
        continue;
      }
      const msg = r.error.message;
      const offline = isOffline(r.error);
      console.log(
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
    if (verifiedAny) writeAccounts(accounts); // persist fresh verifiedAt stamps and teams
  }

  // Project ownership — asks Convex who owns each linked project's deployment.
  // Catches wrong links, re-confirms projects after a team rename, and drops
  // deployments an account no longer owns (a project moved between teams).
  const relinks: Array<{ path: string; to: string }> = [];
  if (tokenChecks && linksOk) {
    const checks = Object.entries(readLinks())
      .map(([path, name]) => ({ path, name, env: projectEnv(path) }))
      .filter((c) => accounts[c.name] && c.env.deployment && existsSync(c.path));
    if (checks.length) {
      console.log(bold("\nProjects:"));
      let changed = false;
      for (let i = 0; i < checks.length; i += 4) {
        const batch = checks.slice(i, i + 4);
        const owners = await Promise.all(batch.map((c) => findOwner(c.env, accounts, c.name)));
        batch.forEach((c, j) => {
          const owner = owners[j];
          const where = shortPath(c.path).padEnd(28);
          if (owner === undefined) return console.log(`  ${yellow("!")} ${where} ${dim("couldn't check")}`);
          changed = true;
          if (owner === c.name) return console.log(`  ${green("✓")} ${where} ${accountColor(c.name)}`);
          const acc = accounts[c.name];
          acc.deployments = acc.deployments?.filter((d) => d !== c.env.deployment);
          if (owner === null) {
            healthy = false;
            return console.log(`  ${yellow("▲")} ${where} ${dim(`no stored account can see ${c.env.deployment}`)}`);
          }
          if (!flags.fix) healthy = false; // --fix relinks it below
          relinks.push({ path: c.path, to: owner });
          console.log(
            `  ${yellow("▲")} ${where} ${dim(`linked to ${c.name}, owned by`)} ${accountColor(owner)}` +
              (flags.fix ? "" : dim(`  → cvx link ${owner} ${shortPath(c.path)}`)),
          );
        });
      }
      if (changed) writeAccounts(accounts);
    }
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
      const file = hookFile(shell);
      if (file && installHook(shell, file) === "added") fixed(`installed the ${shell} cd-hook into ${shortPath(file)}`);
    }
    for (const { shell, file } of staleHooks) {
      const r = installHook(shell, file);
      if (r === "updated") fixed(`updated the ${shell} hook in ${shortPath(file)}`);
      else if (r === "manual")
        console.log(dim(`      → the ${shell} hook block in ${shortPath(file)} is incomplete — reinstall it by hand (cvx hook)`));
    }

    // Wrong links → point them at the account Convex says owns the project.
    if (relinks.length) {
      const links = readLinks();
      for (const r of relinks) links[r.path] = r.to;
      writeLinks(links);
      for (const r of relinks) fixed(`relinked ${shortPath(r.path)} → ${r.to}`);
    }

    // Color clashes → give each clashing account its own palette color.
    if (clashing.length) {
      for (const name of clashing) {
        const taken = Object.keys(accounts).filter((n) => n !== name).map(accountColorCode);
        accounts[name].color = nextAccountColor(taken);
        writeAccounts(accounts); // re-registers the colors for the next pick
        fixed(`gave ${accountColor(name)} its own color`);
      }
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

/** Accounts whose color repeats an earlier account's, or is alarm red / warning yellow. */
function colorClashes(accounts: Accounts): string[] {
  const seen = new Set<number>();
  return Object.keys(accounts).filter((name) => {
    const code = accountColorCode(name);
    const clash = seen.has(code) || isReservedColor(code);
    seen.add(code);
    return clash;
  });
}
