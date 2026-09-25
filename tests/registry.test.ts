import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { COMMANDS, findCommand } = await import("../src/commands/registry");
const { completionFor } = await import("../src/completions");
const { help } = await import("../src/ui");

const listed = COMMANDS.filter((c) => c.usage);

describe("command registry", () => {
  test("every name and alias resolves to exactly one command", () => {
    const names = COMMANDS.flatMap((c) => c.names);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(findCommand(n)?.names).toContain(n);
  });

  test("help, every completion script, and the man page cover every listed command", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (s = "") => lines.push(String(s));
    try {
      help(COMMANDS);
    } finally {
      console.log = log;
    }
    const helpText = lines.join("\n");
    const spec = {
      commands: COMMANDS.map((c) => c.names[0]),
      accountCommands: COMMANDS.filter((c) => c.takesAccount).map((c) => c.names[0]),
    };
    const man = readFileSync(join(import.meta.dir, "..", "man", "cvx.1"), "utf8").replace(/\\f[BIR]/g, "");
    for (const c of listed) {
      const name = c.names[0];
      expect(helpText).toContain(`cvx ${c.usage}`);
      for (const sh of ["zsh", "bash", "fish", "powershell"])
        expect(completionFor(sh, spec)).toMatch(new RegExp(`\\b${name}\\b`));
      expect(man).toMatch(new RegExp(`cvx ${name}\\b`));
    }
  });
});
