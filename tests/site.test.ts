import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_PALETTE } from "../src/colors";
import { RESTING } from "../src/vex";

// site/vex.js is a plain browser script with its own copy of the palette, so
// the site and the terminal must be kept in step by hand; this catches drift.
const vexJs = readFileSync(join(import.meta.dir, "..", "site", "vex.js"), "utf8");

describe("site palette", () => {
  test("site/vex.js wears the same colors as the CLI", () => {
    const palette = vexJs.match(/const PALETTE = \[([\d,\s]+)\];/)?.[1];
    expect(palette?.split(",").map(Number)).toEqual(ACCOUNT_PALETTE);
    expect(Number(vexJs.match(/const RESTING = (\d+);/)?.[1])).toBe(RESTING);
  });
});
