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
import {
  cmdAdd,
  cmdLogin,
  cmdRefresh,
  cmdLink,
  cmdUnlink,
  cmdRename,
  cmdRm,
  cmdEmail,
  cmdReset,
  cmdDisable,
  cmdEnable,
  cmdActivate,
  cmdUse,
  cmdScan,
  cmdRun,
  cmdOpen,
  cmdStatus,
  cmdAccounts,
  cmdLs,
  cmdWhich,
  cmdPrompt,
  cmdVersion,
  cmdDoctor,
  cmdKeychain,
  cmdVault,
  cmdUndo,
  cmdCompletions,
  cmdHook,
} from "../src/commands";
import { cmdUpgrade } from "../src/upgrade";
import { cmdExport, cmdImport } from "../src/transfer";

// Run on every cd or prompt: they only read the vault (missing files read as
// empty), so they skip the vault setup's filesystem checks.
const HOT = new Set(["activate", "prompt", "which"]);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!HOT.has(cmd)) ensureVault();

  switch (cmd) {
    case "add":
      return cmdAdd(rest);
    case "login":
      return cmdLogin(rest);
    case "refresh":
      return cmdRefresh(rest);
    case "link":
      return cmdLink(rest);
    case "unlink":
      return cmdUnlink(rest);
    case "rename":
    case "mv":
      return cmdRename(rest);
    case "rm":
    case "remove":
      return cmdRm(rest);
    case "email":
      return cmdEmail(rest);
    case "reset":
    case "nuke":
      return cmdReset(rest);
    case "disable":
      return cmdDisable();
    case "enable":
      return cmdEnable();
    case "activate":
      return cmdActivate(rest);
    case "use":
      return cmdUse(rest);
    case "scan":
      return cmdScan(rest);
    case "run":
      return cmdRun(rest);
    case "open":
      return cmdOpen(rest);
    case "status":
      return cmdStatus(rest);
    case "accounts":
      return cmdAccounts(rest);
    case "ls":
    case "list":
      return cmdLs();
    case "which":
      return cmdWhich(rest);
    case "prompt":
      return cmdPrompt(rest);
    case "undo":
      return cmdUndo(rest);
    case "keychain":
      return cmdKeychain(rest);
    case "vault":
      return cmdVault(rest);
    case "export":
      return cmdExport(rest);
    case "import":
      return cmdImport(rest);
    case "upgrade":
      return cmdUpgrade();
    case "completions":
    case "completion":
      return cmdCompletions(rest);
    case "hook":
      return cmdHook(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "welcome":
      return welcome();
    case "version":
    case "-v":
    case "--version":
      return cmdVersion();
    case "help":
    case "-h":
    case "--help":
      return help();
    case undefined:
      // Bare `cvx`: greet on the very first run, otherwise show help.
      if (isFirstRun()) {
        markWelcomed();
        return welcome();
      }
      return help();
    default:
      die(`Unknown command: ${cmd}\nRun ${bold("cvx help")}.`);
  }
}

main().catch((e) => {
  // Clean one-line error for users; full stack only when CVX_DEBUG is set.
  if (process.env.CVX_DEBUG) console.error(e?.stack ?? e);
  die(e?.message ?? String(e));
});
