import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The preload (tests/preload.ts) bound CVX_HOME to a throwaway sandbox before
// any test file loaded — use THAT, never a private mkdtemp, so this file's
// direct fs paths always match where store actually reads/writes.
const SANDBOX = process.env.CVX_HOME!;
const store = await import("../src/store");

describe("validAccountName", () => {
  test("accepts normal names", () => {
    for (const n of ["work", "me-2", "a.b_c", "A1"]) expect(store.validAccountName(n)).toBe(true);
  });
  test("rejects unsafe names", () => {
    for (const n of ["__proto__", "_x", ".hidden", "-flag", "", "a b", "é", "x".repeat(65)])
      expect(store.validAccountName(n)).toBe(false);
  });
});

describe("vault I/O", () => {
  test("ensureVault creates files; accounts round-trip", () => {
    store.ensureVault();
    store.writeAccounts({ a: { token: "t1", teams: [], addedAt: "2026-01-01" } });
    expect(store.readAccounts().a.token).toBe("t1");
  });

  test("corrupt vault file throws instead of silently resetting", () => {
    writeFileSync(join(SANDBOX, ".convex-switch", "accounts.json"), "{broken");
    expect(() => store.readAccounts()).toThrow(/corrupted/);
    store.writeAccounts({}); // restore
  });
});

describe("active marker", () => {
  test("writeActive stores name + fingerprint; readActive returns the name", () => {
    store.writeActive("acct", "tok-123");
    expect(store.readActive()).toBe("acct");
    expect(store.activeMarkerMatches("acct", "tok-123")).toBe(true);
  });
  test("wrong token or wrong name does not match", () => {
    store.writeActive("acct", "tok-123");
    expect(store.activeMarkerMatches("acct", "other")).toBe(false);
    expect(store.activeMarkerMatches("other", "tok-123")).toBe(false);
  });
  test("old one-line marker (no fingerprint) never matches", () => {
    writeFileSync(join(SANDBOX, ".convex-switch", "active"), "acct\n");
    expect(store.readActive()).toBe("acct");
    expect(store.activeMarkerMatches("acct", "tok-123")).toBe(false);
  });
});

describe("setConvexToken", () => {
  test("preserves other fields and writes atomically", () => {
    const cfg = join(SANDBOX, ".convex", "config.json");
    mkdirSync(join(SANDBOX, ".convex"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ accessToken: "old", other: 42 }));
    store.setConvexToken("new-tok");
    const after = JSON.parse(readFileSync(cfg, "utf8"));
    expect(after.accessToken).toBe("new-tok");
    expect(after.other).toBe(42);
    expect(store.currentConvexToken()).toBe("new-tok");
  });
});

describe("projectDeployment", () => {
  const proj = join(SANDBOX, "proj");
  const write = (line: string) => {
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, ".env.local"), line + "\n");
  };

  test("strips type prefix and quotes", () => {
    write('CONVEX_DEPLOYMENT="dev:happy-otter-123"');
    expect(store.projectDeployment(proj)).toBe("happy-otter-123");
  });
  test("strips inline comment tails", () => {
    write("CONVEX_DEPLOYMENT=prod:my-app-42 # team: foo");
    expect(store.projectDeployment(proj)).toBe("my-app-42");
  });
  test("rejects values with unsafe characters (URL/shell injection guard)", () => {
    write("CONVEX_DEPLOYMENT=dev:evil&calc");
    expect(store.projectDeployment(proj)).toBe(null);
  });
  test("null when no .env.local exists", () => {
    expect(store.projectDeployment(SANDBOX)).toBe(null);
  });
});

describe("links", () => {
  test("resolveLink walks up to the nearest linked ancestor", () => {
    mkdirSync(join(SANDBOX, "repo", "sub"), { recursive: true });
    const base = store.canon(join(SANDBOX, "repo")); // canon AFTER mkdir, like cmdLink
    store.writeLinks({ [base]: "acct" });
    expect(store.resolveLink(join(SANDBOX, "repo", "sub"))?.account).toBe("acct");
    expect(store.resolveLink(tmpdir())).toBe(null);
  });
});

describe("team identity (renamed teams)", () => {
  const acme = { id: 7, slug: "acme", name: "Acme" };
  test("mergeTeams keeps a renamed team's old slugs as aliases, across renames", () => {
    const once = store.mergeTeams([acme], [{ id: 7, slug: "acme-labs", name: "Acme Labs" }]);
    expect(once).toEqual([{ id: 7, slug: "acme-labs", name: "Acme Labs", aliases: ["acme"] }]);
    const twice = store.mergeTeams(once, [{ id: 7, slug: "acme-inc", name: "Acme Inc" }]);
    expect(twice[0].aliases).toEqual(["acme", "acme-labs"]);
  });
  test("mergeTeams pairs id-less stored teams by name, or one-to-one", () => {
    const byName = store.mergeTeams(
      [{ slug: "old", name: "Same" }, { slug: "x", name: "X" }],
      [{ id: 1, slug: "new", name: "Same" }],
    );
    expect(byName[0].aliases).toEqual(["old"]);
    const single = store.mergeTeams([{ slug: "a", name: "A" }], [{ id: 2, slug: "b", name: "B" }]);
    expect(single[0].aliases).toEqual(["a"]);
  });
  test("mergeTeams gives an unrelated new team no aliases", () => {
    const out = store.mergeTeams([acme], [acme, { id: 9, slug: "side", name: "Side" }]);
    expect(out[1]).toEqual({ id: 9, slug: "side", name: "Side" });
  });
  test("ownsProject: confirmed deployment beats a stale note; aliases match; nothing to compare is null", () => {
    const acc = { teams: [{ ...acme, slug: "acme-labs", aliases: ["acme"] }], addedAt: "", deployments: ["happy-1"] };
    expect(store.ownsProject(acc, { deployment: "happy-1", team: "someone-else" })).toBe(true);
    expect(store.ownsProject(acc, { deployment: "other-2", team: "acme" })).toBe(true);
    expect(store.ownsProject(acc, { deployment: "other-2", team: "nope" })).toBe(false);
    expect(store.ownsProject(acc, { deployment: "other-2", team: null })).toBeNull();
  });
  test("deploymentOwner surfaces network/auth failures as errors (online or offline)", async () => {
    await expect(store.deploymentOwner("not-a-real-token", "happy-otter-123")).rejects.toThrow(
      /Convex|token/,
    );
  });
});
