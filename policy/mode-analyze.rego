# Deckhand's default capabilities for analyses of past runs (the dashboard's Analyze), which read
# the runs' digest and the code (docs/repo-config/policies.md#capabilities). A grants folder's
# policy/mode-analyze.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "analyze"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}
