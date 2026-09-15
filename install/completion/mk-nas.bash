# bash completion for mk-nas: the command asks the agent for pool, dataset, snapshot and disk names.
_mk_nas() {
  local cur=${COMP_WORDS[COMP_CWORD]}
  local IFS=$'\n'
  COMPREPLY=($(compgen -W "$(mk-nas __complete "${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)" -- "$cur"))
}
complete -F _mk_nas mk-nas
