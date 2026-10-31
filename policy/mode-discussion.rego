# Deckhand's default capabilities for discussion runs, which read the code and answer in the
# discussion (docs/repo-config.md#capabilities). A grants folder's policy/mode-discussion.rego
# replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "discussion"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:discussions",
    "read:actions",
  }
}
