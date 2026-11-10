# Deckhand's default for context repos (docs/repo-config.md#context-repos): every built-in mode
# with `pull` gets `read:context` (its mode-<mode>.rego), which a run uses only when the
# repository's .deckhand.yaml names `context_repos` and the operator's grants list them. Never on
# a fork's pull request: what its comments ask for could be read out of the other repositories.
# A grants folder's policy/context.rego replaces it.
package deckhand

deny_capabilities contains {"capability": "read:context", "reason": msg} if {
  input.fork
  msg := "a pull request from a fork reads no context repos"
}
