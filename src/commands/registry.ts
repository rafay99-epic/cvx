/**
 * registry — every cvx command, once. Dispatch (bin/cvx.ts), `cvx help`, and
 * the shell completion scripts are all generated from this table, so a new
 * command shows up everywhere by adding one entry here.
 */

import { completionFor } from "../completions";
import { detectShell } from "../hooks";
import { bold, die, help, welcome, type HelpGroup } from "../ui";
import { parseFlags } from "../args";
import { cmdUpgrade } from "../upgrade";
import { cmdExport, cmdImport } from "../transfer";
import { cmdAdd, cmdLogin, cmdRefresh, cmdRename, cmdRm, cmdEmail } from "./accounts";
import { cmdLink, cmdUnlink, cmdActivate, cmdUse, cmdScan, cmdRun, cmdOpen, cmdWhich, cmdPrompt } from "./links";
import { cmdStatus, cmdAccounts, cmdLs, cmdVersion } from "./status";
import { cmdReset, cmdDisable, cmdEnable, cmdKeychain, cmdVault, cmdUndo } from "./storage";
import { cmdDoctor } from "./doctor";
import { cmdHook } from "./hook";

export type Command = {
  names: readonly [string, ...string[]]; // canonical name first, then aliases
  run: (args: string[]) => unknown;
  usage?: string; // shown in help; commands without one are hidden
  summary?: string;
  group?: HelpGroup;
  takesAccount?: true; // completion offers account names for the first argument
  hot?: true; // runs on every cd or prompt: read-only, skips vault setup
};

export const COMMANDS: readonly Command[] = [
  { names: ["add"], run: cmdAdd, usage: "add [name]", summary: "store the current login as <name> (verified)", group: "setup" },
  { names: ["login"], run: cmdLogin, usage: "login <name>", summary: "log in and store it as <name>", group: "setup" },
  { names: ["refresh"], run: cmdRefresh, usage: "refresh <account|--all>", summary: "re-authenticate one account, or all", group: "setup", takesAccount: true },

  { names: ["link"], run: cmdLink, usage: "link <account> [path]", summary: "link a project dir (default: cwd) to an account", group: "wire", takesAccount: true },
  { names: ["unlink"], run: cmdUnlink, usage: "unlink [path]", summary: "remove a link", group: "wire" },
  { names: ["scan"], run: cmdScan, usage: "scan [dir]", summary: "auto-discover projects and link them", group: "wire" },
  { names: ["hook"], run: cmdHook, usage: "hook --install", summary: "add the auto-switch hook (zsh/bash/fish/nu/pwsh)", group: "wire" },
  { names: ["completions", "completion"], run: cmdCompletions, usage: "completions <shell>", summary: "print a shell completion script", group: "wire" },

  { names: ["use"], run: cmdUse, usage: "use [account]", summary: "activate by name, or pick one if unlinked", group: "everyday", takesAccount: true },
  { names: ["run"], run: cmdRun, usage: "run <account> -- <cmd>", summary: "run one command as <account> (no global change)", group: "everyday", takesAccount: true },
  { names: ["open"], run: cmdOpen, usage: "open", summary: "open the Convex dashboard for this project", group: "everyday" },
  { names: ["status"], run: cmdStatus, usage: "status [--json]", summary: "show the active account and this dir's link", group: "everyday" },
  { names: ["accounts"], run: cmdAccounts, usage: "accounts", summary: "list stored accounts (+ last verified)", group: "everyday" },
  { names: ["ls", "list"], run: cmdLs, usage: "ls", summary: "list linked projects", group: "everyday" },

  { names: ["rename", "mv"], run: cmdRename, usage: "rename <old> <new>", summary: "rename an account, keep its links", group: "manage", takesAccount: true },
  { names: ["email"], run: cmdEmail, usage: "email <account> [addr]", summary: "label an account with its email", group: "manage", takesAccount: true },
  { names: ["rm", "remove"], run: cmdRm, usage: "rm <account>", summary: "forget an account (asks first; undo-able)", group: "manage", takesAccount: true },
  { names: ["disable"], run: cmdDisable, usage: "disable", summary: "pause cvx (cd stops switching)", group: "manage" },
  { names: ["enable"], run: cmdEnable, usage: "enable", summary: "resume switching", group: "manage" },
  { names: ["reset", "nuke"], run: cmdReset, usage: "reset", summary: "delete ALL accounts, links & sessions (asks first)", group: "manage" },
  { names: ["undo"], run: cmdUndo, usage: "undo [--list]", summary: "restore the vault to before the last change", group: "manage" },
  { names: ["which"], run: cmdWhich, usage: "which [path]", summary: "print the account name for a dir (scripting)", group: "manage", hot: true },
  { names: ["prompt"], run: cmdPrompt, usage: "prompt [--starship]", summary: "print the active account · starship config", group: "manage", hot: true },
  { names: ["keychain"], run: cmdKeychain, usage: "keychain <status|…>", summary: "store tokens in the OS keychain", group: "manage" },
  { names: ["vault"], run: cmdVault, usage: "vault <status|…>", summary: "passphrase-encrypt stored tokens", group: "manage" },
  { names: ["export"], run: cmdExport, usage: "export [file]", summary: "encrypted vault backup (for a new machine)", group: "manage" },
  { names: ["import"], run: cmdImport, usage: "import <file>", summary: "restore an encrypted backup", group: "manage" },
  { names: ["doctor"], run: cmdDoctor, usage: "doctor [--fix]", summary: "check setup, tokens and links (--fix repairs)", group: "manage" },
  { names: ["upgrade"], run: cmdUpgrade, usage: "upgrade", summary: "check for a newer release", group: "manage" },
  { names: ["welcome"], run: welcome, usage: "welcome", summary: "the welcome screen", group: "manage" },
  { names: ["version", "-v", "--version"], run: cmdVersion, usage: "version", summary: "print the version", group: "manage" },

  { names: ["activate"], run: cmdActivate, hot: true }, // the shell hook's entry point
  { names: ["help", "-h", "--help"], run: () => help(COMMANDS) },
];

export const findCommand = (name: string) => COMMANDS.find((c) => c.names.includes(name));

function cmdCompletions(args: string[]) {
  const shell = parseFlags(args)._[0] || detectShell();
  const script = completionFor(shell, {
    commands: COMMANDS.map((c) => c.names[0]),
    accountCommands: COMMANDS.filter((c) => c.takesAccount).map((c) => c.names[0]),
  });
  if (!script) {
    if (shell === "nu") die("Nushell completions aren't available yet (the cd-hook works: `cvx hook --shell nu`).");
    die(`Usage: ${bold("cvx completions <zsh|bash|fish|powershell>")}`);
  }
  process.stdout.write(script);
}
