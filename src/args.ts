/**
 * Tiny flag parser: `--flag`, `--key=value`, bundled short flags `-qf`, and a
 * fixed set of long flags that take the next argument as their value.
 * Everything else is positional (collected in `_`).
 */

// The only flags that consume the next argument. Every other `--flag` is
// boolean, so it can never swallow a following positional
// (`cvx link --force myacct` keeps `myacct` positional).
const VALUE_FLAGS = new Set(["token", "shell", "depth", "email"]);

/**
 * Positionals in `_`; every flag seen maps to its value, or `true` for a
 * switch (and for a value flag given without one). `--key=value` works for
 * any flag.
 */
export type Flags = { _: string[]; [flag: string]: string | true | string[] | undefined };

export function parseFlags(args: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = args[i + 1];
        // A value flag never eats something that looks like another flag —
        // `cvx add x --token --force` must not read `--force` as the token.
        // Values that DO start with a dash can be passed as `--token=-abc`.
        if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) out[ch] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}
