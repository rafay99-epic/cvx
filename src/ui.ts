/**
 * ui — everything the user sees: ANSI colors, the gradient logo, Vex the
 * account chameleon, the first-run welcome, and the help screen. Pure
 * presentation, no fs/network.
 */

import { VAULT, shortPath } from "./store";
import { VERSION } from "./version";
import { FACE, RESTING, TAIL, type VexMood } from "./vex";
import type { Account } from "./store";
import {
  bold,
  dim,
  red,
  cyan,
  fg256,
  brandLine,
  accountColorCode,
} from "./colors";

// Re-export the palette so the rest of the app can import colors from "./ui".
export { bold, dim, green, yellow, red, cyan, accountColor } from "./colors";

export function die(msg: string): never {
  console.error(red("✗ ") + msg);
  process.exit(1);
}

/**
 * Prompt without echoing (passphrases). Scripts should prefer the
 * CVX_PASSPHRASE env var; callers check it before prompting.
 */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY)
    die("This prompt needs a terminal. In scripts, set CVX_PASSPHRASE instead.");
  // stderr, not stdout: the prompt must stay visible when stdout is redirected,
  // and must never leak into piped/captured command output.
  process.stderr.write(question);
  const stdin = process.stdin;
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          return resolve(buf);
        }
        if (ch === "\x03") {
          // Ctrl-C
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function teamLabel(acc: Account): string {
  if (!acc.teams.length) return dim("(unverified)");
  return dim(acc.teams.map((t) => t.slug).join(", "));
}

// --- The logo (Convex-brand gradient: yellow → red → purple) -----------------

const LOGO = [
  " ██████╗██╗   ██╗██╗  ██╗",
  "██╔════╝██║   ██║╚██╗██╔╝",
  "██║     ██║   ██║ ╚███╔╝ ",
  "██║     ╚██╗ ██╔╝ ██╔██╗ ",
  "╚██████╗ ╚████╔╝ ██╔╝ ██╗",
  " ╚═════╝  ╚═══╝  ╚═╝  ╚═╝ ",
];

export function banner(): string {
  const art = LOGO.map((line, i) => "  " + brandLine(line, i, LOGO.length)).join("\n");
  return `\n${art}\n  ${dim("convex-switch")} ${dim("v" + VERSION)} ${dim(
    "· one terminal, every Convex account",
  )}\n`;
}

// --- Vex, printed (her moods and faces live in vex.ts) ------------------------

/** Vex, one glyph tall. Pass an account name to dress her in its color. */
export function vex(mood: VexMood = "happy", accountName?: string | null): string {
  const code = accountName ? accountColorCode(accountName) : RESTING;
  return fg256(code, FACE[mood] + TAIL);
}

/**
 * Vex appended to an action's result line — she reacts to what just happened.
 * Empty when piped, so scripted output stays byte-identical (output hygiene).
 */
export function vexTag(mood: VexMood = "happy", accountName?: string | null): string {
  return process.stdout.isTTY ? `  ${vex(mood, accountName)}` : "";
}

/**
 * Welcome intro: Vex blinks and shifts through a few account colors before
 * settling — chameleons gonna chameleon. TTY-only; pipes get one static line.
 */
async function vexIntro(): Promise<void> {
  const tag = dim("Vex — the account chameleon");
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    console.log(`  ${vex()}  ${tag}\n`);
    return;
  }
  const frames: Array<[VexMood, number]> = [
    ["blink", RESTING],
    ["happy", RESTING],
    ["happy", 45],
    ["happy", 213],
    ["happy", 214],
    ["happy", 141],
    ["blink", RESTING],
    ["happy", RESTING],
  ];
  process.stdout.write("\x1b[?25l");
  for (const [mood, code] of frames) {
    process.stdout.write(`\r  ${fg256(code, FACE[mood] + TAIL)}  ${dim("…")}`);
    await new Promise((r) => setTimeout(r, 130));
  }
  process.stdout.write(`\r\x1b[2K\x1b[?25h  ${vex()}  ${tag}\n\n`);
}

// --- First-run welcome ------------------------------------------------------

export async function welcome(): Promise<void> {
  console.log(banner());
  await vexIntro();
  console.log(`  ${bold("Welcome!")} ${dim("Vex turns the color of whatever account is active.")}
  Run all your Convex accounts across projects at once —
  no login/logout churn, no deploy keys, no tokens in your repos.

  ${bold("Get started")} ${dim("(one time)")}
    ${cyan("1")}  ${bold("cvx login <name>")}     ${dim("sign into an account and name it")}
    ${cyan("2")}  ${bold("cvx link <account>")}   ${dim("bind the current project to it")}
    ${cyan("3")}  ${bold("cvx hook --install")}   ${dim("auto-switch when you cd (adds a zsh hook)")}

  Then just ${bold("cd")} into a project and run your dev server — the right
  account is already active.

  ${dim("All commands:")} ${bold("cvx help")}   ${dim("·")}   ${dim("Manual:")} ${bold("man cvx")}
`);
}

// --- Help -------------------------------------------------------------------

export type HelpGroup = "setup" | "wire" | "everyday" | "manage";

// Help sections in order, with the non-cvx lines that belong in each.
const HELP_GROUPS: Array<{ id: HelpGroup; title: string; note?: string; extra?: Array<[string, string]> }> = [
  { id: "setup", title: "Setup", note: "(one-time per account)", extra: [["npx convex login", "log into an account in your browser"]] },
  { id: "wire", title: "Wire projects to accounts" },
  { id: "everyday", title: "Everyday", extra: [["cd <project> && bun run dev", "the linked account is activated automatically"]] },
  { id: "manage", title: "Manage" },
];

const h = (s: string) => bold(cyan(s));
const helpLine = (usage: string, summary: string) =>
  `  ${usage.length >= 30 ? usage + "  " : usage.padEnd(30)}${summary}`;

/** The help screen, generated from the command registry (commands without a usage are hidden). */
export function help(commands: readonly { usage?: string; summary?: string; group?: HelpGroup }[]): void {
  console.log(banner());
  console.log(`  ${dim("switch Convex accounts per project, automatically")}\n`);
  for (const g of HELP_GROUPS) {
    console.log(h(g.title) + (g.note ? " " + dim(g.note) : ""));
    for (const [usage, summary] of g.extra ?? []) console.log(helpLine(usage, summary));
    for (const c of commands)
      if (c.group === g.id && c.usage) console.log(helpLine("cvx " + c.usage, c.summary ?? ""));
    console.log();
  }
  console.log(`Vault: ${cyan(shortPath(VAULT))}  ${dim("(chmod 600, never in your projects)")}`);
}
