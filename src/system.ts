/**
 * system — checks for external tools the CLI depends on. NOTE: `cvx` is a
 * Bun-compiled binary, so `process.versions.node` reflects the bundled runtime,
 * not the user's Node. Convex's own CLI runs via the user's `npx`, so we must
 * probe the real system PATH here — hence spawning, not process.versions.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const isWindows = process.platform === "win32";

/** True if `<cmd> --version` runs successfully from the system PATH. */
export function hasCommand(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], {
      stdio: "ignore",
      shell: isWindows, // resolve npx.cmd / PATHEXT on Windows
      timeout: 8000,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name on Windows via PATH + PATHEXT, the way cmd.exe
 * itself does. Bun.which only finds executable IMAGES (.exe) — npx and most
 * Node-tool entry points are .cmd shims it never sees. Returns the input
 * untouched when it already contains a path separator (trust the caller) or
 * when nothing matches (spawnSync then surfaces ENOENT, which cmdRun reports
 * as "Command not found").
 */
function resolveWindowsCommand(cmd: string): string {
  if (/[\\/]/.test(cmd)) return cmd;
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  const hasExt = /\.[^\\/.]+$/.test(cmd);
  const exts = hasExt
    ? [""]
    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs)
    for (const ext of exts) {
      const f = join(dir, cmd + ext);
      if (existsSync(f)) return f;
    }
  return cmd;
}

/**
 * Run a child process inheriting our stdio, with arguments passed through
 * verbatim. `shell: true` is avoided on Windows: Node would join argv with
 * spaces and cmd.exe re-split it, shredding arguments with spaces or quotes.
 *
 *  - POSIX: spawn directly, no shell.
 *  - Windows: resolve the executable via PATH + PATHEXT (resolveWindowsCommand).
 *      * `.cmd`/`.bat` shims (e.g. npx.cmd) are not executable images and can
 *        only run through cmd.exe — see the strategy note at the spawn site.
 *      * a real `.exe` / extensionless native binary skips the shell entirely.
 *    An unresolvable name falls through as-is, letting spawnSync raise ENOENT
 *    which cmdRun reports as "Command not found".
 */
export function runInherit(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  if (!isWindows) {
    return spawnSync(cmd, args, { stdio: "inherit", env });
  }

  const resolved = resolveWindowsCommand(cmd);
  const lower = resolved.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    // Pass the args as an ARRAY and let Bun build the command line. Verified
    // on the Windows runners: spaced args survive this path, while a manually
    // caret-quoted verbatim line does NOT — Bun's spawnSync ignores
    // windowsVerbatimArguments and re-mangles it. Known cmd quirk that
    // remains: %VAR% inside an argument still expands.
    return spawnSync("cmd.exe", ["/d", "/c", resolved, ...args], { stdio: "inherit", env });
  }
  return spawnSync(resolved, args, { stdio: "inherit", env });
}

/** Open a URL in the user's default browser. Returns false if it couldn't. */
export function openUrl(url: string): boolean {
  try {
    const r =
      process.platform === "darwin"
        ? spawnSync("open", [url], { stdio: "ignore" })
        : process.platform === "win32"
          ? spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" })
          : spawnSync("xdg-open", [url], { stdio: "ignore" });
    return !r.error && (r.status === 0 || r.status === null);
  } catch {
    return false;
  }
}
