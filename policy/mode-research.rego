# Deckhand's default capabilities for research runs: the open internet, which the operator's
# `research` grant (`allow_grant`) gates too, and nothing of the repository's
# (docs/repo-config.md#capabilities). A grants folder's policy/mode-research.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "research"
  some c in {
    "internet",
  }
}
