# Deckhand's default capabilities for bug inbox entries, which read the code and file issues
# (docs/repo-config.md#capabilities). A grants folder's policy/mode-bug.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "bug"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}
