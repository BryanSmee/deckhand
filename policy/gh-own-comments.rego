# Deckhand's default for the comments a run posted (`edit`, `delete` on `created_comment`:
# docs/repo-config.md#a-runs-own-comments). A grants folder's policy/gh-own-comments.rego
# replaces it: never past the mode's ceiling, which holds them for work runs and the
# repository's modes that aren't light, on the comments they posted only (never the listener's,
# another run's or a person's). Work runs (a maintainer's, a review's fix run, a conflict's)
# correct their own comments; the repository's own modes once its .deckhand/policy/ allows it
# (`allow_github`).
package deckhand

# A deleted comment leaves no trace of what it said: a run edits its mistake instead.
deny_github contains msg if {
  input.target.kind == "created_comment"
  input.action == "delete"
  msg := "a run doesn't delete its comments unless the operator's policy/gh-own-comments.rego lets it: edit yours instead"
}
