#!/usr/bin/env bun
/**
 * convex-switch (cvx) — bind Convex accounts to projects and auto-activate the
 * right one when you cd into a project. No deploy keys, no tokens in project
 * files. It swaps the single global ~/.convex/config.json, which is the one
 * place the Convex CLI reads your account from.
 *
 * This file is just the entry point + dispatch. Logic lives in src/.
 */

import { ensureVault, isFirstRun, markWelcomed } from "../src/store";
import { die, help, welcome, bold } from "../src/ui";
import { COMMANDS, findCommand } from "../src/commands/registry";

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const cmd = name === undefined ? undefined : findCommand(name);
  // The cd hook and prompt only read the vault (missing files read as empty),
  // so they skip the setup's filesystem checks.
  if (!cmd?.hot) ensureVault();

  if (name === undefined) {
    // Bare `cvx`: greet on the very first run, otherwise show help.
    if (isFirstRun()) {
      markWelcomed();
      return welcome();
    }
    return help(COMMANDS);
  }
  if (!cmd) die(`Unknown command: ${name}\nRun ${bold("cvx help")}.`);
  return cmd.run(rest);
}

main().catch((e) => {
  // Clean one-line error for users; full stack only when CVX_DEBUG is set.
  if (process.env.CVX_DEBUG) console.error(e?.stack ?? e);
  die(e?.message ?? String(e));
});
