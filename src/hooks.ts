/**
 * hooks — shell snippets that run `cvx activate` on directory change AND at
 * the prompt when another session swapped the global Convex config, so the
 * linked account is selected automatically as you move between projects and
 * never stays stolen by a second terminal. One per supported shell;
 * `cvx hook` prints the right one, `--install` wires it into the shell's
 * startup file (replacing an outdated block in place).
 *
 * Per-session isolation: the hooks eval `cvx activate --env`, which prints an
 * export of CONVEX_OVERRIDE_ACCESS_TOKEN (honored by the Convex CLI above the
 * global config) + CVX_ACCOUNT for the linked account — so two terminals on
 * different accounts run in parallel without fighting over the one global
 * ~/.convex/config.json. The global swap still happens as a fallback for
 * anything not running under a hooked shell (IDEs, older Convex CLIs).
 * In --env mode stdout is eval'd, so human messages arrive on stderr.
 *
 * Hot-path rule: the per-prompt check must be spawn-free. Each shell keeps a
 * per-shell stamp file and uses its builtin `-nt` (newer-than) test against
 * the global config — `cvx activate` is only spawned when the config actually
 * changed under us (or on a real cd).
 */

export type Shell = "zsh" | "bash" | "powershell" | "fish" | "nu";

/**
 * Sentinel baked into every snippet below (the `--- convex-switch ---` marker
 * lines). Install and doctor grep startup files for it, so it must match the
 * snippets' marker text.
 */
export const HOOK_MARKER = "convex-switch";
const BLOCK_START = "# --- convex-switch ";
const BLOCK_END = "# --- end convex-switch ";

/** Startup file per shell, relative to $HOME. PowerShell has no fixed path — its $PROFILE is resolved at runtime. */
export const RC_FILES: Record<Exclude<Shell, "powershell">, string> = {
  zsh: ".zshrc",
  bash: ".bashrc",
  fish: ".config/fish/config.fish",
  nu: ".config/nushell/config.nu",
};

// zsh: chpwd on directory change, plus a precmd that re-syncs only when the
// global config file is newer than this shell's stamp (builtin -nt, no spawn).
// The eval exports this session's token (stdout is eval-safe; messages are on
// stderr) so parallel terminals hold different accounts at the same time.
const HOOK_ZSH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project, and
# re-sync at the prompt if another terminal switched the global config.
__CVX_STAMP="\${TMPDIR:-/tmp}/.cvx-stamp-\${USER:-u}-$$"
_convex_switch_hook() {
  (( $+commands[cvx] )) || return 0
  eval "$(command cvx activate -q --env)"
  : >| "$__CVX_STAMP"
}
_convex_switch_precmd() {
  [[ "\${CVX_HOME:-$HOME}/.convex/config.json" -nt "$__CVX_STAMP" ]] && _convex_switch_hook
}
autoload -Uz add-zsh-hook 2>/dev/null &&
  add-zsh-hook chpwd _convex_switch_hook &&
  add-zsh-hook precmd _convex_switch_precmd
_convex_switch_hook   # run once for the current directory
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// bash: no chpwd, so hook PROMPT_COMMAND — fire on $PWD change or when the
// global config is newer than this shell's stamp (builtin -nt, no spawn).
const HOOK_BASH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project, and
# re-sync at the prompt if another terminal switched the global config.
__CVX_STAMP="\${TMPDIR:-/tmp}/.cvx-stamp-\${USER:-u}-$$"
__convex_switch_sync() {
  command -v cvx >/dev/null 2>&1 || return 0
  eval "$(command cvx activate -q --env)"
  : >| "$__CVX_STAMP"
}
__convex_switch_hook() {
  if [ "$PWD" != "$__CVX_LAST_PWD" ]; then
    __CVX_LAST_PWD="$PWD"
    __convex_switch_sync
  elif [ "\${CVX_HOME:-$HOME}/.convex/config.json" -nt "$__CVX_STAMP" ]; then
    __convex_switch_sync
  fi
}
case "$PROMPT_COMMAND" in
  *__convex_switch_hook*) ;;
  *) PROMPT_COMMAND="__convex_switch_hook\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}" ;;
esac
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// PowerShell (native Windows): wrap the prompt function once; fire when $PWD
// changes or the global config's write time moved (in-process check, no spawn).
const HOOK_PWSH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you change directory, and
# re-sync at the prompt if another terminal switched the global config.
if (-not $global:__cvx_hooked) {
  $global:__cvx_hooked = $true
  $global:__cvx_last = ''
  $global:__cvx_stamp = [datetime]0
  $global:__cvx_cfg = Join-Path $(if ($env:CVX_HOME) { $env:CVX_HOME } else { $HOME }) '.convex\\config.json'
  $global:__cvx_orig_prompt = $function:prompt
  function global:prompt {
    $m = [System.IO.File]::GetLastWriteTimeUtc($global:__cvx_cfg)
    if ($PWD.Path -ne $global:__cvx_last -or $m -gt $global:__cvx_stamp) {
      $global:__cvx_last = $PWD.Path
      $e = cvx activate -q --env --shell powershell 2>$null
      if ($e) { Invoke-Expression ($e -join "; ") }
      $global:__cvx_stamp = [System.IO.File]::GetLastWriteTimeUtc($global:__cvx_cfg)
    }
    if ($global:__cvx_orig_prompt) { & $global:__cvx_orig_prompt } else { "PS $($PWD.Path)> " }
  }
}
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// fish: PWD variable event for cd, plus a fish_prompt event that re-syncs
// only when the global config is newer than this shell's stamp (builtin test).
const HOOK_FISH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project, and
# re-sync at the prompt if another terminal switched the global config.
set -q CVX_HOME; and set -g __cvx_cfg "$CVX_HOME/.convex/config.json"; or set -g __cvx_cfg "$HOME/.convex/config.json"
set -q TMPDIR; and set -g __cvx_stamp "$TMPDIR/.cvx-stamp-$USER-$fish_pid"; or set -g __cvx_stamp "/tmp/.cvx-stamp-$USER-$fish_pid"
function __convex_switch_sync
  command -q cvx; or return
  eval (command cvx activate -q --env --shell fish | string collect)
  true > $__cvx_stamp
end
function __convex_switch_hook --on-variable PWD
  __convex_switch_sync
end
function __convex_switch_prompt --on-event fish_prompt
  if test "$__cvx_cfg" -nt "$__cvx_stamp"
    __convex_switch_sync
  end
end
__convex_switch_sync
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// Nushell: register a PWD env-change hook. Best-effort — hook syntax varies by
// Nushell version; tested against recent releases. No prompt-time resync here:
// env mutations inside nu closure hooks don't persist between prompts, so the
// stamp-guard pattern the other shells use would spawn cvx on EVERY prompt —
// and for the same reason no per-session --env export either (nu sessions get
// the global-config swap only).
const HOOK_NU = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you change directory.
$env.config.hooks.env_change.PWD = (
  $env.config.hooks.env_change.PWD? | default [] | append {|before, after| ^cvx activate -q }
)
# --- end convex-switch -----------------------------------------------------
`.trimStart();

export const SHELLS: Shell[] = ["zsh", "bash", "powershell", "fish", "nu"];
export const isShell = (s: unknown): s is Shell => SHELLS.includes(s as Shell);

export function hookFor(shell: Shell): string {
  switch (shell) {
    case "bash": return HOOK_BASH;
    case "powershell": return HOOK_PWSH;
    case "fish": return HOOK_FISH;
    case "nu": return HOOK_NU;
    default: return HOOK_ZSH;
  }
}

/**
 * Swap an existing `--- convex-switch ---` block in a startup file's body for
 * `snippet`. Returns the new body, or null when no complete block was found
 * (no markers, or a start without an end — leave hand-edited files alone).
 * "unchanged" means a complete block was found and already matches.
 */
export function replaceHookBlock(
  body: string,
  snippet: string,
): { body: string; changed: boolean } | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.includes(BLOCK_START));
  if (start === -1) return null;
  const endRel = lines.slice(start).findIndex((l) => l.includes(BLOCK_END));
  if (endRel === -1) return null;
  const end = start + endRel;
  // Compare modulo \r: a CRLF rc file (a Windows $PROFILE, or an rc touched by
  // a Windows editor) with current content must not read as outdated forever.
  const current = lines.slice(start, end + 1).map((l) => l.replace(/\r$/, "")).join("\n") + "\n";
  if (current === snippet) return { body, changed: false };
  // Match the file's line endings: swapping an LF snippet into a CRLF file
  // (a Windows $PROFILE) must not leave it with mixed endings.
  const crlf = lines[start].endsWith("\r");
  const block = crlf
    ? snippet.trimEnd().split("\n").map((l) => l + "\r").join("\n")
    : snippet.trimEnd();
  const next = [...lines.slice(0, start), block, ...lines.slice(end + 1)];
  return { body: next.join("\n"), changed: true };
}

// --- per-session env export (`cvx activate --env`) ---------------------------

const ENV_TOKEN = "CONVEX_OVERRIDE_ACCESS_TOKEN"; // read by the Convex CLI, wins over ~/.convex/config.json
const ENV_NAME = "CVX_ACCOUNT"; // the account name, for prompts/scripts

/**
 * One eval-able line that binds (or clears) this shell session's Convex
 * account. `acct` present → export the token + name; absent → unset both, so
 * the session falls back to the global config. Always a single line, and the
 * only thing `activate --env` may print to stdout.
 */
export function envLine(shell: Shell, acct?: { name: string; token: string }): string {
  switch (shell) {
    case "fish": {
      if (!acct) return `set -e ${ENV_NAME}; set -e ${ENV_TOKEN}`;
      const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
      return `set -gx ${ENV_NAME} ${q(acct.name)}; set -gx ${ENV_TOKEN} ${q(acct.token)}`;
    }
    case "powershell": {
      if (!acct) return `Remove-Item Env:${ENV_NAME},Env:${ENV_TOKEN} -ErrorAction SilentlyContinue`;
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
      return `$env:${ENV_NAME} = ${q(acct.name)}; $env:${ENV_TOKEN} = ${q(acct.token)}`;
    }
    default: {
      // posix (zsh/bash). nu never reaches here — its hook doesn't use --env.
      if (!acct) return `unset ${ENV_NAME} ${ENV_TOKEN}`;
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      return `export ${ENV_NAME}=${q(acct.name)} ${ENV_TOKEN}=${q(acct.token)}`;
    }
  }
}

/** Best-effort shell detection when the user doesn't pass --shell. */
export function detectShell(): Shell {
  if (process.platform === "win32") return "powershell";
  const sh = process.env.SHELL ?? "";
  if (sh.includes("fish")) return "fish";
  if (sh.includes("nu")) return "nu";
  if (sh.includes("bash")) return "bash";
  return "zsh"; // default on unix
}
