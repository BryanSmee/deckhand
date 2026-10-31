# Deckhand's default capabilities for pull request reviews, which read the code and the pull
# request; the listener posts the review (docs/repo-config.md#capabilities). Not the pull
# request's branch image (`image:branch`), which needs `push`. A grants folder's
# policy/mode-review.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "review"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}
