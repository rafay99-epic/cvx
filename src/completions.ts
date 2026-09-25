/**
 * completions — shell completion scripts for cvx. They complete subcommands and,
 * for account-taking subcommands, live account names by shelling out to
 * `cvx accounts --names` (which prints one bare name per line).
 */

/** What the scripts complete: every command, and those whose first argument is an account. */
export type CompletionSpec = { commands: string[]; accountCommands: string[] };

const zsh = (cmds: string, accts: string) => `#compdef cvx
_cvx() {
  local -a _cmds
  _cmds=(${cmds})
  if (( CURRENT == 2 )); then
    _describe -t commands 'cvx command' _cmds
    return
  fi
  case "\${words[2]}" in
    ${accts.split(" ").join("|")})
      if (( CURRENT == 3 )); then
        local -a _accts
        _accts=(\${(f)"\$(cvx accounts --names 2>/dev/null)"})
        _describe -t accounts 'account' _accts
      fi ;;
    unlink|open|which|scan) _files -/ ;;
    import|export) _files ;;
    completions) _values 'shell' zsh bash fish powershell ;;
    hook) _values 'shell' zsh bash fish nu powershell ;;
    keychain) _values 'subcommand' status enable disable ;;
    vault) _values 'subcommand' status encrypt decrypt unlock lock ;;
  esac
}
_cvx "\$@"
`;

const bash = (cmds: string, accts: string) => `_cvx() {
  local cur cmds
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmds="${cmds}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$cmds" -- "\$cur") ); return
  fi
  case "\${COMP_WORDS[1]}" in
    ${accts.split(" ").join("|")})
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "\$(cvx accounts --names 2>/dev/null)" -- "\$cur") )
      fi ;;
    completions) COMPREPLY=( \$(compgen -W "zsh bash fish powershell" -- "\$cur") ) ;;
    hook) COMPREPLY=( \$(compgen -W "zsh bash fish nu powershell --install --shell" -- "\$cur") ) ;;
    keychain) COMPREPLY=( \$(compgen -W "status enable disable" -- "\$cur") ) ;;
    vault) COMPREPLY=( \$(compgen -W "status encrypt decrypt unlock lock" -- "\$cur") ) ;;
    unlink|open|which|scan) COMPREPLY=( \$(compgen -d -- "\$cur") ) ;;
    import|export) COMPREPLY=( \$(compgen -f -- "\$cur") ) ;;
  esac
}
complete -F _cvx cvx
`;

const fish = (cmds: string, accts: string) => `# cvx fish completions
complete -c cvx -f
complete -c cvx -n "__fish_use_subcommand" -a "${cmds}"
complete -c cvx -n "__fish_seen_subcommand_from ${accts}" -a "(cvx accounts --names 2>/dev/null)"
complete -c cvx -n "__fish_seen_subcommand_from completions" -a "zsh bash fish powershell"
complete -c cvx -n "__fish_seen_subcommand_from hook" -a "zsh bash fish nu powershell"
complete -c cvx -n "__fish_seen_subcommand_from keychain" -a "status enable disable"
complete -c cvx -n "__fish_seen_subcommand_from vault" -a "status encrypt decrypt unlock lock"
complete -c cvx -n "__fish_seen_subcommand_from import export" -F
`;

const pwsh = (cmds: string, accts: string) => `Register-ArgumentCompleter -Native -CommandName cvx -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(${cmds.split(" ").map((c) => `'${c}'`).join(",")})
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($tokens.Count -le 2) {
    $cmds | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $sub = $tokens[1]
  $vals = @()
  if ($sub -in ${accts.split(" ").map((c) => `'${c}'`).join(",")}) { $vals = @(cvx accounts --names 2>$null) }
  elseif ($sub -eq 'completions') { $vals = 'zsh','bash','fish','powershell' }
  elseif ($sub -eq 'hook') { $vals = 'zsh','bash','fish','nu','powershell' }
  elseif ($sub -eq 'keychain') { $vals = 'status','enable','disable' }
  elseif ($sub -eq 'vault') { $vals = 'status','encrypt','decrypt','unlock','lock' }
  $vals | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;

export function completionFor(shell: string, spec: CompletionSpec): string | null {
  const all = spec.commands.join(" ");
  const acct = spec.accountCommands.join(" ");
  switch (shell) {
    case "zsh": return zsh(all, acct);
    case "bash": return bash(all, acct);
    case "fish": return fish(all, acct);
    case "powershell": case "pwsh": return pwsh(all, acct);
    default: return null;
  }
}
