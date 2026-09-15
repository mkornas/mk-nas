#compdef mk-nas
# zsh completion for mk-nas: the command asks the agent for pool, dataset, snapshot and disk names.
local -a candidates
candidates=(${(f)"$(mk-nas __complete "${words[@]:1:$((CURRENT-2))}" 2>/dev/null)"})
compadd -a candidates
