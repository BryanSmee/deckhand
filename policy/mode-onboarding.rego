# Deckhand's default capabilities for onboarding runs, which read the code and propose a
# .deckhand.yaml (docs/repo-config/policies.md#capabilities). A grants folder's policy/mode-onboarding.rego
# replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "onboarding"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}
