/**
 * hook — the cd-hook installer and shell completions.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { type Shell, hookFor, detectShell, isShell, SHELLS, HOOK_MARKER, RC_FILES, replaceHookBlock } from "../hooks";
import { HOME, shortPath } from "../store";
import { bold, dim, green, yellow, cyan, die, vexTag } from "../ui";
import { parseFlags } from "../args";

// --- hook -------------------------------------------------------------------

export function cmdHook(args: string[]) {
  const flags = parseFlags(args);
  const shell = isShell(flags.shell) ? flags.shell : flags.shell === undefined ? detectShell() : null;
  if (!shell) die(`Unknown shell ${bold(String(flags.shell))}. Use --shell ${SHELLS.join("|")}.`);
  const snippet = hookFor(shell);

  if (!flags.install) {
    process.stdout.write(snippet);
    return;
  }
  const file = hookFile(shell);
  if (!file) {
    console.log(yellow("Couldn't find PowerShell. Add this to your $PROFILE manually:") + "\n");
    process.stdout.write(snippet);
    return;
  }
  const where = cyan(shortPath(file));
  const reopen = shell === "powershell" ? "Open a new PowerShell window" : "Open a new terminal";
  switch (installHook(shell, file)) {
    case "added":
      console.log(`${green("✓")} Added hook to ${where}.${vexTag("happy")}`);
      console.log(dim(`  ${reopen} to activate it.`));
      break;
    case "updated":
      console.log(`${green("✓")} Updated the hook in ${where}.${vexTag("happy")}`);
      console.log(dim(`  ${reopen} to pick up the new version.`));
      break;
    case "unchanged":
      console.log(yellow(`Hook already up to date in ${shortPath(file)} — nothing to do.`));
      break;
    case "manual":
      console.log(
        yellow(`Found a ${HOOK_MARKER} marker in ${shortPath(file)} but not a complete hook block.`) +
          `\n  Remove the old lines, then re-run ${bold("cvx hook --install")} (or paste ${bold("cvx hook")}'s output).`,
      );
  }
}

/**
 * The startup file `shell`'s hook lives in. PowerShell's $PROFILE is resolved
 * by asking pwsh, except under CVX_HOME: a sandbox must never spawn the real
 * pwsh and then overwrite the machine's actual profile. null = no PowerShell.
 */
export function hookFile(shell: Shell): string | null {
  if (shell !== "powershell") return join(HOME, RC_FILES[shell]);
  if (process.env.CVX_HOME) return join(HOME, "powershell_profile.ps1");
  const profileOf = (exe: string) => {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  return profileOf("pwsh") || profileOf("powershell") || null;
}

export type InstallResult = "added" | "updated" | "unchanged" | "manual";

/**
 * Write `shell`'s cd-hook into `file`: appended when absent, swapped in place
 * when an older block is installed (so binary upgrades can ship hook fixes),
 * left alone when already current. "manual" = a marker is present but the
 * block is incomplete (hand-edited): never rewritten. Prints nothing; the
 * callers (`cvx hook --install`, `doctor --fix`) report.
 */
export function installHook(shell: Shell, file: string): InstallResult {
  const snippet = hookFor(shell);
  const body = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (body.includes(HOOK_MARKER)) {
    const swapped = replaceHookBlock(body, snippet);
    if (!swapped) return "manual";
    if (!swapped.changed) return "unchanged";
    writeFileSync(file, swapped.body);
    return "updated";
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, "\n" + snippet);
  return "added";
}
