/**
 * colors — the palette. This is the ONE place to restyle the whole CLI:
 * change a code here and every command picks it up. Codes are ANSI SGR
 * (e.g. "32" = green, "38;5;45" = a 256-color foreground).
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const truecolor =
  useColor && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

/** Wrap text in an ANSI SGR code (a no-op when color is disabled). */
export const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

/** 256-color foreground helper (used by gradients' fallback + account colors). */
export const fg256 = (n: number, s: string) => c(`38;5;${n}`, s);

// --- Named styles — tweak these to re-theme -------------------------------
export const bold = (s: string) => c("1", s);
export const dim = (s: string) => c("2", s);
export const green = (s: string) => c("32", s);
export const yellow = (s: string) => c("33", s);
export const red = (s: string) => c("31", s);
export const cyan = (s: string) => c("36", s);

// --- Gradients -------------------------------------------------------------

export type RGB = [number, number, number];

// The Convex brand triad — the banner fades through these, top to bottom.
export const BRAND: RGB[] = [
  [243, 176, 28], // yellow
  [238, 52, 47], // red
  [141, 38, 118], // purple
];

// 256-color approximations of the same fade, for terminals without truecolor.
const BRAND_256 = [214, 208, 203, 197, 162, 133];

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** Sample a multi-stop gradient at t ∈ [0,1]. */
function sample(stops: RGB[], t: number): RGB {
  const span = 1 / (stops.length - 1);
  const i = Math.min(Math.floor(t / span), stops.length - 2);
  const local = (t - i * span) / span;
  const [a, b] = [stops[i], stops[i + 1]];
  return [lerp(a[0], b[0], local), lerp(a[1], b[1], local), lerp(a[2], b[2], local)];
}

/**
 * Color line `i` of `n` with the brand gradient. Truecolor when the terminal
 * has it, a 256-color fade otherwise, plain text with colors off.
 */
export function brandLine(s: string, i: number, n: number): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  if (truecolor) {
    const [r, g, b] = sample(BRAND, t);
    return c(`38;2;${r};${g};${b}`, s);
  }
  return fg256(BRAND_256[Math.min(Math.floor(t * BRAND_256.length), BRAND_256.length - 1)], s);
}

// --- Account colors ----------------------------------------------------------
// Every account keeps one color everywhere (accounts, ls, status, switch
// messages, Vex), so you learn to recognize accounts at a glance. New accounts
// get the first free color in ACCOUNT_PALETTE, stored on the account, so up to
// eight accounts never share one. The palette has no red or yellow (those mean
// alarm and warning) and nothing near Vex's resting green. site/vex.js keeps a
// copy; tests/site.test.ts checks they match.

export const ACCOUNT_PALETTE = [45, 141, 214, 213, 111, 180, 116, 176];

// Accounts stored before colors were assigned keep their old name-hash color,
// so nobody's colors change under them. `cvx doctor --fix` reassigns clashes.
const LEGACY_PALETTE = [45, 213, 118, 214, 141, 81, 203, 227, 87, 156];
const RESERVED = new Set([203, 227]); // alarm red, warning yellow

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

const stored = new Map<string, number>();

/** Register each account's stored color. store.readAccounts calls this on every read. */
export function useAccountColors(accounts: Record<string, { color?: number }>) {
  stored.clear();
  for (const [name, acc] of Object.entries(accounts))
    if (typeof acc.color === "number") stored.set(name, acc.color);
}

/** The 256-color code an account wears. */
export function accountColorCode(name: string): number {
  return stored.get(name) ?? LEGACY_PALETTE[hash(name) % LEGACY_PALETTE.length];
}

/** The first palette color not in `taken` (wraps once all eight are used). */
export function nextAccountColor(taken: number[]): number {
  return ACCOUNT_PALETTE.find((c) => !taken.includes(c)) ?? ACCOUNT_PALETTE[taken.length % ACCOUNT_PALETTE.length];
}

export const isReservedColor = (code: number) => RESERVED.has(code);

/** Colorize an account name with its stable color (bold, for emphasis). */
export function accountColor(name: string, text?: string): string {
  return c(`1;38;5;${accountColorCode(name)}`, text ?? name);
}
