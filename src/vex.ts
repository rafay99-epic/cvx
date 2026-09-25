/**
 * vex — Vex, the account chameleon: her moods and faces, one glyph tall. She
 * wears the active account's color and rests in green. ui.ts and spinner.ts
 * print her; site/vex.js draws the same moods as SVG.
 */

export type VexMood = "happy" | "wink" | "blink" | "alarm" | "sleepy" | "curious" | "sad" | "excited";

export const FACE: Record<VexMood, string> = {
  happy: "(◕‿◕)",
  wink: "(◕‿<)",
  blink: "(–‿–)",
  alarm: "(⊙︵⊙)",
  sleepy: "(–ᴗ–)ᶻ",
  curious: "(◕.◕)?",
  sad: "(◕︵◕)",
  excited: "(☆‿☆)",
};

/** Her tail, the `@` curl after every face. */
export const TAIL = "~@";

/** Resting green (256-color), worn when no account is active. */
export const RESTING = 114;
