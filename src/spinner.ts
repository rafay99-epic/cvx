/**
 * spinner — Vex works while you wait: tail wags, occasional blink. Used for
 * network waits (verify, doctor). On a real terminal she animates in place;
 * piped/scripted output prints nothing until stop, then exactly the final
 * line — identical to the pre-spinner output. Never used on the cd-hook hot
 * path.
 */

import { dim, fg256 } from "./colors";
import { FACE, RESTING, TAIL } from "./vex";

// Tail wag + a blink every full cycle.
const FRAMES = [FACE.happy + TAIL, FACE.happy + "∿@", FACE.happy + TAIL, FACE.blink + "∿@"];

export type Spinner = { stop(finalLine: string): void };

/**
 * Animate `label` until stop(finalLine) replaces the whole line with
 * `finalLine`.
 */
export function spin(label: string): Spinner {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return { stop: (finalLine) => console.log(finalLine) };
  }
  let i = 0;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const draw = () =>
    process.stdout.write(`\r${fg256(RESTING, FRAMES[i++ % FRAMES.length])} ${dim(label)}`);
  draw();
  const timer = setInterval(draw, 140);
  // Ctrl-C mid-spin must not leave the terminal with a hidden cursor.
  const onSigint = () => {
    process.stdout.write("\r\x1b[2K\x1b[?25h");
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  return {
    stop(finalLine) {
      clearInterval(timer);
      process.removeListener("SIGINT", onSigint);
      process.stdout.write(`\r\x1b[2K\x1b[?25h${finalLine}\n`);
    },
  };
}
