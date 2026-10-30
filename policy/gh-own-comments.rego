# Deckhand's default for the comments a run posted (`edit`, `delete` on `created_comment`:
# docs/repo-config.md#the-github-input). A repository broadens it with its own
# .deckhand/policy/gh-own-comments.rego, which replaces this file: never past the mode's
# ceiling, which holds them for work runs and the repository's modes that aren't light, on the
# comments they posted only (never the listener's, another run's or a person's).
package deckhand

# Work runs (a maintainer's, a review's fix run, a conflict's) correct their own comments; the
# repository's own modes don't, unless it says so.
deny_github contains msg if {
  input.target.kind == "created_comment"
  input.mode != "work"
  msg := sprintf("a %s run doesn't change its comments unless .deckhand/policy/gh-own-comments.rego lets it", [input.mode])
}

# A deleted comment leaves no trace of what it said: a run edits its mistake instead.
deny_github contains msg if {
  input.target.kind == "created_comment"
  input.action == "delete"
  msg := "a run doesn't delete its comments unless .deckhand/policy/gh-own-comments.rego lets it: edit yours instead"
}
