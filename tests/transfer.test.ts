import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Unix file-mode bits (0600) aren't meaningful on Windows.
const WIN = process.platform === "win32";

// The preload (tests/preload.ts) bound CVX_HOME to a throwaway sandbox before
// any test file loaded — use THAT, never a private mkdtemp.
const SANDBOX = process.env.CVX_HOME!;
// A passphrase in the env keeps the commands from ever prompting for a TTY.
process.env.CVX_PASSPHRASE = "correct-horse-battery";

const store = await import("../src/store");
const transfer = await import("../src/transfer");

const EXPORT_FILE = join(SANDBOX, "vault.export");

const acct = (token: string) => ({ token, teams: [{ slug: "t", name: "Team" }], addedAt: "2026-01-01" });

function seedVault() {
  store.ensureVault();
  store.writeAccounts({ work: acct("tok-work"), personal: acct("tok-personal") });
  store.writeLinks({ [join(SANDBOX, "proj")]: "work" });
}

beforeEach(() => {
  seedVault();
});

afterAll(() => {
  // Leave a clean, empty vault behind.
  store.writeAccounts({});
  store.writeLinks({});
});

describe("packVault / unpackVault", () => {
  test("round-trips accounts (tokens inline) and links", () => {
    const blob = transfer.packVault(process.env.CVX_PASSPHRASE!);
    const out = transfer.unpackVault(process.env.CVX_PASSPHRASE!, blob);
    expect(out).not.toBeNull();
    expect(out!.accounts.work.token).toBe("tok-work");
    expect(out!.accounts.personal.token).toBe("tok-personal");
    expect(out!.accounts.work.teams[0].slug).toBe("t");
    expect(out!.links[join(SANDBOX, "proj")]).toBe("work");
  });

  test("wrong passphrase → null", () => {
    const blob = transfer.packVault(process.env.CVX_PASSPHRASE!);
    expect(transfer.unpackVault("not-the-passphrase", blob)).toBeNull();
  });

  test("tampered blob → null", () => {
    const parsed = JSON.parse(transfer.packVault(process.env.CVX_PASSPHRASE!));
    // Flip a byte in the ciphertext; GCM authentication must reject it.
    const b = Buffer.from(parsed.data, "base64");
    b[b.length - 1] ^= 0xff;
    parsed.data = b.toString("base64");
    expect(transfer.unpackVault(process.env.CVX_PASSPHRASE!, JSON.stringify(parsed))).toBeNull();
  });

  test("a non-export file → null", () => {
    expect(transfer.unpackVault(process.env.CVX_PASSPHRASE!, "{\"kind\":\"other\"}")).toBeNull();
    expect(transfer.unpackVault(process.env.CVX_PASSPHRASE!, "not json")).toBeNull();
  });

  test("a decryptable but malformed payload → null (never tokenless accounts)", async () => {
    const crypto = await import("../src/crypto");
    const pp = process.env.CVX_PASSPHRASE!;
    const seal = (payload: unknown) => {
      const salt = crypto.newSalt();
      const data = crypto.encrypt(crypto.deriveKey(pp, salt), JSON.stringify(payload));
      return JSON.stringify({ v: 1, kind: "cvx-export", salt: salt.toString("base64"), data });
    };
    expect(transfer.unpackVault(pp, seal({ accounts: "nope", links: {} }))).toBeNull();
    expect(transfer.unpackVault(pp, seal({ accounts: { a: { teams: [] } }, links: {} }))).toBeNull();
    expect(transfer.unpackVault(pp, seal({ accounts: {}, links: { "/p": 42 } }))).toBeNull();
  });
});

describe("cmdExport", () => {
  test("writes a 0600 file with tokens resolved inline", async () => {
    await transfer.cmdExport([EXPORT_FILE]);
    // Unix file-mode bits are meaningless on Windows — skip just this assertion.
    if (!WIN) expect(statSync(EXPORT_FILE).mode & 0o777).toBe(0o600);
    const outer = JSON.parse(readFileSync(EXPORT_FILE, "utf8"));
    expect(outer.kind).toBe("cvx-export");
    // The written file, once unpacked, carries the plain tokens.
    const payload = transfer.unpackVault(process.env.CVX_PASSPHRASE!, readFileSync(EXPORT_FILE, "utf8"));
    expect(payload!.accounts.work.token).toBe("tok-work");
  });
});

describe("cmdImport", () => {
  test("export → wipe → import restores accounts and links with tokens", async () => {
    await transfer.cmdExport([EXPORT_FILE]);
    // Simulate a fresh machine: empty the vault, then import.
    store.writeAccounts({});
    store.writeLinks({});
    await transfer.cmdImport([EXPORT_FILE]);

    const accounts = store.readAccounts();
    expect(Object.keys(accounts).sort()).toEqual(["personal", "work"]);
    expect(store.tokenOf("work", accounts.work)).toBe("tok-work");
    expect(store.tokenOf("personal", accounts.personal)).toBe("tok-personal");
    expect(store.readLinks()[join(SANDBOX, "proj")]).toBe("work");
  });

  test("account metadata (email) survives export → import; stray secret fields don't", async () => {
    store.writeAccounts({ work: { ...acct("tok-work"), email: "me@work.dev" } });
    await transfer.cmdExport([EXPORT_FILE]);
    store.writeAccounts({});
    await transfer.cmdImport([EXPORT_FILE]);
    const work = store.readAccounts().work;
    expect(work.email).toBe("me@work.dev");
    expect(work.teams[0].slug).toBe("t");
    expect(work.pw).toBeUndefined();
  });

  test("skips existing accounts without --force, overwrites with --force", async () => {
    await transfer.cmdExport([EXPORT_FILE]);
    // Local "work" has a different token; a plain import must keep it.
    store.writeAccounts({ work: acct("local-token") });
    store.writeLinks({});

    await transfer.cmdImport([EXPORT_FILE]);
    expect(store.tokenOf("work", store.readAccounts().work)).toBe("local-token");
    expect(store.readAccounts().personal.token).toBe("tok-personal"); // new one still added

    await transfer.cmdImport([EXPORT_FILE, "--force"]);
    expect(store.tokenOf("work", store.readAccounts().work)).toBe("tok-work");
  });
});
