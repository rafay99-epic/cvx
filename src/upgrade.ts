/**
 * upgrade — checks GitHub for a newer release and tells the user exactly how
 * to get it. Never replaces the running binary itself.
 */

import { VERSION } from "./version";
import { bold, dim, green, yellow, cyan, vexTag } from "./ui";

const RELEASES_API = "https://api.github.com/repos/rafay99-epic/cvx/releases/latest";
const RELEASES_URL = "https://github.com/rafay99-epic/cvx/releases/latest";

export type Channel = "homebrew" | "npm" | "github";

/** Compare dotted numeric versions ("0.42" vs "0.43.0"); junk segments -> 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    const va = Number.isFinite(na) ? na : 0;
    const vb = Number.isFinite(nb) ? nb : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Which install channel produced the running binary, guessed from its path. */
export function detectChannel(execPath: string): Channel {
  if (/[\\/](Cellar|homebrew|linuxbrew)[\\/]/.test(execPath)) return "homebrew";
  if (/[\\/](node_modules|\.bun|npm)[\\/]/.test(execPath)) return "npm";
  return "github";
}

function upgradeCommand(channel: Channel): string {
  if (channel === "homebrew") return "brew upgrade cvx";
  if (channel === "npm")
    return `bun add -g @rafay99/cvx@latest  ${dim("(or: npm i -g @rafay99/cvx@latest)")}`;
  return RELEASES_URL;
}

export async function cmdUpgrade(): Promise<void> {
  console.log(bold("cvx upgrade") + "\n");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  let latestTag: string;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== "string") throw new Error("unexpected response shape");
    latestTag = body.tag_name;
  } catch {
    console.log(yellow("  couldn't check for updates — are you online?"));
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(t);
  }

  const latest = latestTag.replace(/^v/, "");

  if (VERSION === "0.0.0-dev") {
    console.log(`  latest release available: ${bold(latest)}`);
    console.log(dim("  this is a dev build — version comparison doesn't apply"));
    return;
  }

  if (compareVersions(VERSION, latest) >= 0) {
    console.log(green(`  ✓ up to date (${VERSION})`) + vexTag("happy"));
    return;
  }

  console.log(`  ${dim(VERSION)} → ${bold(latest)} available${vexTag("excited")}\n`);
  const channel = detectChannel(process.execPath);
  console.log(`  ${dim(`(${channel})`)} run:`);
  console.log(`    ${cyan(upgradeCommand(channel))}`);
}
