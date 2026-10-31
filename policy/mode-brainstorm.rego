# Deckhand's default capabilities for brainstorms and their wrap-up (`/stop`), which read the
# code and the issues and answer, without a branch or the repository's setup
# (docs/repo-config.md#capabilities). A grants folder's policy/mode-brainstorm.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode in {"brainstorm", "stop"}
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}
