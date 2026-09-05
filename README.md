# Convex Switch (`cvx`)

Run multiple Convex accounts across multiple projects at once — without
logging in and out, without deploy keys, and without putting any secrets in
your project files.

You link a project folder to an account **once**. After that, the moment you
`cd` into that folder the right account becomes active, and plain
`bun run dev` (i.e. `convex dev`) just works. Start 5–6 projects in 5–6
terminals — each grabs its own account as it launches and they all run at the
same time.

```
  (◕‿◕)~@    happy — the right account is active
  (⊙︵⊙)~@    alarmed — this project's team doesn't match the account
  (–ᴗ–)ᶻ~@   asleep — the encrypted vault is locked
  (◕‿<)~@    that's `cvx doctor` coming back clean
```

Meet **Vex**, the account chameleon. A chameleon changes color to match its
surroundings; cvx changes your account to match your project — so Vex wears
the **active account's color** and her face reacts to what's going on. Every
account gets a stable color of its own, used across `accounts`, `ls`, and
switch messages, so you learn to recognize where you are at a glance.

## Purpose

The Convex CLI only remembers **one** logged-in account at a time — it lives in
a single global file, `~/.convex/config.json`. If you juggle several Convex
accounts (personal, work, clients) across many projects, that means constantly
`convex logout` / `convex login` churn every time you switch projects, and you
can never run two accounts' projects side by side.

`convex-switch` removes that friction entirely. Log into each account once, tag
it, and bind your projects to accounts. From then on the correct account is
selected automatically per project — no manual switching, no deploy keys, and
no tokens sitting inside your repositories. It turns "which account am I on
right now?" into a non-question.

## How it works (the one trick)

The Convex CLI decides *which account you are* by reading a single global file:

```
~/.convex/config.json   →   { "accessToken": "..." }
```

`cvx` keeps a private vault of your account tokens and a map of
project → account. A shell hook calls `cvx activate` on every `cd`, and also
re-checks at the prompt so a second terminal swapping the global file gets
noticed — a spawn-free freshness check means nothing runs on a normal prompt.
When you enter a linked folder (or the check trips) it rewrites that one
global file to the linked account. Nothing is injected at runtime, nothing
lives in your repos.

```
~/.convex-switch/
  accounts.json   # name -> { token, teams }        (chmod 600)
  links.json      # /abs/project/path -> account     (chmod 600)
```

Because a running `convex dev` caches its deployment credentials at startup,
swapping the global file afterwards doesn't disturb sessions already
running — that's what makes true simultaneous multi-account work.

## Install

**Homebrew** (macOS + Linux):

```bash
brew install rafay99-epic/apps/cvx
cvx hook --install   # adds the cd-hook to ~/.zshrc (once)
exec zsh             # reload your shell
```

**npm / bun / pnpm** — installs the same prebuilt binary:

```bash
npm install -g @rafay99/cvx      # or: bun add -g @rafay99/cvx
pnpm add -g @rafay99/cvx
cvx hook --install
exec zsh
```

> Distributed the esbuild way: per-platform packages
> (`@rafay99/cvx-<os>-<arch>`) carry the binary, gated by `os`/`cpu`, and a
> tiny launcher in the main package (`@rafay99/cvx`) execs it. No postinstall —
> so it works under `bun add -g` and `--ignore-scripts` too. The command you
> type is still `cvx`.

Prebuilt binaries: **macOS** (arm64/x64), **Linux** (arm64/x64), **Windows**
(x64). Auto-switching works on **zsh, bash, and PowerShell** — `cvx hook
--install` detects your shell (PowerShell on Windows) and wires the hook into
the right startup file (`~/.zshrc`, `~/.bashrc`, or your PowerShell `$PROFILE`).
Force one with `cvx hook --install --shell powershell`. Working in several
terminals at once? The hook binds the account **per shell session**: it
exports `CONVEX_OVERRIDE_ACCESS_TOKEN` (which the Convex CLI reads above the
global config), so two terminals in different projects run as different
accounts *at the same time* — nobody steals anybody's login. The global
config is still swapped as a fallback for tools that don't run under a
hooked shell, and every hook re-syncs at the prompt when another session
swapped it. Note this puts the linked account's token in the session's
environment (visible to processes you start from that shell), same trust
level as the default plaintext vault.

**From source** (Bun):

```bash
bun link             # from this repo — exposes `cvx` globally
cvx hook --install
exec zsh
```

## Set up your accounts (once each)

The easy way — `cvx login <name>` opens a fresh browser sign-in and stores it:

```bash
cvx login personal    # browser sign-in, stored as "personal"
cvx login work        # browser sign-in (different account), stored as "work"
```

> **Gotcha:** plain `npx convex login` **no-ops if the device is already
> authorized** ("This device has previously been authorized…") — so it won't
> switch you to a second account. You must force a fresh sign-in with
> `npx convex login --force`. `cvx login` passes `--force` for you.

Manual equivalent (e.g. to also capture the account you're *already* signed
into):

```bash
cvx add personal            # snapshot the login currently in ~/.convex/config.json
npx convex login --force    # force browser sign-in as the next account
cvx add work
```

## Wire projects to accounts

```bash
cd ~/Code/project-a && cvx link personal
cd ~/Code/project-b && cvx link work
cd ~/Code/project-c && cvx link personal   # one account → many projects
```

## Safety net: the wrong-account guard

The Convex CLI stamps a `# team: …` note on the `CONVEX_DEPLOYMENT` line of
`.env.local`. On every activation (including the automatic cd-hook), cvx
cross-checks that team against the linked account's teams and warns loudly on
a mismatch — catching "about to deploy with the wrong account" *before* it
happens. `cvx status` shows the same warning.

## Daily use

```bash
cd ~/Code/project-a     # ⇄ convex account → personal
bun run dev             # runs as personal

# new terminal, at the same time:
cd ~/Code/project-b     # ⇄ convex account → work
bun run dev             # runs as work — both live simultaneously
```

Both terminals really are live simultaneously: each hooked session exports
its own `CONVEX_OVERRIDE_ACCESS_TOKEN`, which the Convex CLI prefers over the
global config — so `bun run dev` in project-a keeps running as `personal`
while project-b's terminal works as `work`, no matter who touched the global
config last. In an unlinked directory the session variable is cleared and
the global config (plus the prompt-time resync) takes over, exactly as
before. For a one-off command under a specific account there's also
`cvx run <account> -- <cmd>` (per-command token, no session or global
change).

## Commands

| Command | What it does |
| --- | --- |
| `cvx add [name]` | Store the current `~/.convex` login as an account |
| `cvx login <name>` | `npx convex login`, then store it as `<name>` |
| `cvx refresh <account>` / `--all` | Re-authenticate one account — or every account in one sitting |
| `cvx link <account> [path]` | Link a project dir (default cwd) to an account |
| `cvx unlink [path]` | Remove a link |
| `cvx scan [dir] [--depth N] [--yes]` | Auto-discover projects under a dir and link them to accounts by team |
| `cvx rename <old> <new>` | Rename an account, keeping its links |
| `cvx email <account> [addr]` | Label an account with its email (shown in `accounts`/`doctor`; `login`/`add` also ask once, `--clear` removes) |
| `cvx rm <account>` | Forget an account and its links (asks on a TTY; `--force` skips) |
| `cvx disable` / `cvx enable` | Pause cvx — the cd hook stops switching accounts — and resume; nothing is deleted |
| `cvx reset` | Delete ALL cvx state: accounts, links, sessions, undo history (alias `nuke`; asks on a TTY, `--force` in scripts) |
| `cvx undo [--list]` | Restore the vault to before the last change — rm, rename, import, scan, all reversible |
| `cvx use [account]` | Activate by name from anywhere — or this dir's account / an interactive pick |
| `cvx run <account> -- <cmd>` | Run one command as `<account>` without changing the global login |
| `cvx open` | Open the Convex dashboard for this project's deployment |
| `cvx activate [-q] [--env]` | Activate this dir's account (the hook calls this; `--env` prints the session export the hook evals) |
| `cvx status [--json]` | Show the active account and this dir's link |
| `cvx accounts` | List stored accounts (with when each token was last verified) |
| `cvx ls` | List linked projects |
| `cvx which [path]` | Print the account name for a dir (scripting) |
| `cvx prompt [--starship\|--color]` | Prompt segment: bare name · starship config block · ANSI-colored name |
| `cvx keychain <status\|enable\|disable>` | Store tokens in the OS keychain instead of a file |
| `cvx vault <status\|encrypt\|decrypt\|unlock\|lock>` | Passphrase-encrypt stored tokens (unlock once per session) |
| `cvx export [file]` / `cvx import <file>` | Encrypted vault backup / restore — new-machine setup in one command |
| `cvx upgrade` | Check for a newer release and print the exact upgrade command |
| `cvx doctor [--fix]` | Check setup + per-account token health; also refreshes each account's stored team list (`--fix` repairs hook/links/marker/tokens) |
| `cvx completions <shell>` | Print a completion script (zsh/bash/fish/powershell) |
| `cvx hook [--install] [--shell …]` | Install the shell hook (zsh/bash/fish/nu/powershell); `--install` also upgrades an outdated installed hook in place |

### Run a command as another account, without switching

```sh
cvx run work -- npx convex logs        # from anywhere, as the "work" account
cvx run . -- npx convex deploy         # "." = this directory's linked account
```

`cvx run` sets `CONVEX_OVERRIDE_ACCESS_TOKEN` for that one process only — it never
touches your global login, so it's safe in scripts and alongside running dev servers.

### Store tokens in the OS keychain (optional)

By default tokens live in `~/.convex-switch/` (chmod 600). To move them into the
**macOS Keychain**, **libsecret** (Linux), or **DPAPI** (Windows):

```sh
cvx keychain enable      # migrates every account into the OS keychain
cvx keychain disable     # moves them back to the file vault
```

### Shell prompt + completions

```sh
cvx completions zsh >> ~/.zshrc         # tab-complete commands + account names
# starship: show the active account in your prompt
# [custom.cvx]  command = "cvx prompt"  when = "true"  format = "[($output )]($style)"
```

## Upgrading from an older version

The vault is schema-versioned. The first time you run an interactive `cvx`
command after updating from an older release, cvx shows a one-time prompt and,
on confirmation, re-secures your tokens in the file vault (chmod 600)
and upgrades the vault format. It's mandatory and runs once — you never see it
again. The cd-hook and scripts keep working throughout; the prompt only appears
in an interactive terminal. (Migration deliberately stays out of the OS keychain
to avoid keychain prompts during a mandatory step — opt in later with
`cvx keychain enable`.)

## Project layout

The CLI is split into small modules; `bun build --compile` bundles them all into
a single binary, so the split costs nothing at build time.

```
bin/cvx.ts        entry point + command dispatch
src/paths.ts      the ONE place HOME is resolved (CVX_HOME sandbox support)
src/store.ts      data layer: vault I/O, the config swap, token verify
src/ui.ts         the gradient logo, Vex the mascot, welcome, help
src/colors.ts     the palette: brand gradient + per-account colors (re-theme here)
src/spinner.ts    braille spinner for network waits (TTY only)
src/commands.ts   one function per subcommand
src/hooks.ts      zsh / bash / PowerShell shell-hook snippets
src/keychain.ts   OS keychain / DPAPI token backends
src/crypto.ts     scrypt + AES-256-GCM (vault encryption, export files)
src/vault.ts      passphrase-encrypted vault + session unlock
src/transfer.ts   cvx export / import (encrypted backups)
src/upgrade.ts    cvx upgrade (release check)
src/system.ts     external-tool checks (node/npx)
src/args.ts       flag parsing
man/cvx.1         man page (installed by Homebrew/npm → `man cvx`)
```

First run of a bare `cvx` shows a welcome screen; `cvx welcome` shows it again,
and `man cvx` opens the manual.

## Testing

```sh
bun test          # full suite: parser + store units, and an e2e matrix that
                  # drives every command against a throwaway CVX_HOME
```

The suite runs in ~2s, needs no setup, and never touches your real vault —
CI (`.github/workflows/test.yml`) runs it on every PR. Three flows can't run
headless and stay manual (use the sandbox below): real `cvx login` (browser),
the interactive migration prompt (needs a PTY), and `cvx keychain enable`
(the OS keychain is per-user).

## Testing safely (sandbox)

Never test a build against your real vault. Everything cvx touches — the vault,
the global `~/.convex/config.json` it swaps, the rc files `hook --install`
edits — resolves from one base directory, and setting `CVX_HOME` relocates all
of it:

```sh
scripts/sandbox.sh                # build + drop into a shell with an EMPTY sandbox vault
scripts/sandbox.sh --copy-vault   # same, but seeded with a COPY of your real vault
```

Inside that shell `cvx` is the fresh build and every command — `link`,
`activate`, `rm`, even the migration prompt and `hook --install` — reads and
writes only the sandbox. `exit` to leave; your real setup is never touched.
Works without the script too: `CVX_HOME=/tmp/try cvx status`.

One exception can't be sandboxed: the OS keychain is per-user, so skip
`cvx keychain enable` in a sandbox (the default file backend is used anyway).

## Releasing

Pushing to `main` (touching `bin/**` or `package.json`) triggers
`.github/workflows/release.yml`, which:

1. cross-compiles standalone `cvx` binaries for macOS (arm64/x64) and Linux
   (arm64/x64) with `bun build --compile` on a single runner,
2. publishes a GitHub release `v0.<commit-count>` with the tarballs +
   `checksums.txt`, and
3. regenerates the Homebrew formula (all four sha256s) and pushes it to the
   `rafay99-epic/homebrew-apps` tap — no checksum is ever hand-edited.

Step 3 needs a `TAP_TOKEN` repo secret (a fine-grained PAT with
**Contents: Read & Write** on `rafay99-epic/homebrew-apps`); without it the
release still builds and publishes, only the formula bump is skipped.

## Notes

- Tokens live only in `~/.convex-switch/` (chmod 600) — never in a repo,
  never in `.env.local`, no deploy keys.
- To rotate/refresh an account, `npx convex login` into it again then
  `cvx add <name> --force`.
- Unsupported shells: run `cvx hook` and adapt the snippet to your shell's
  directory-change hook — eval the output of `cvx activate -q --env` so the
  session gets its own `CONVEX_OVERRIDE_ACCESS_TOKEN` export — plus a prompt
  hook that re-runs it when the global config file is newer than a per-shell
  stamp.
