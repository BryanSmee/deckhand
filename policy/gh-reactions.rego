# Deckhand's default for reactions (`react`, `unreact`: docs/repo-config.md#reactions). A
# repository broadens it with its own .deckhand/policy/gh-reactions.rego, which replaces this
# file, or refuses reactions altogether there: never past the mode's ceiling, which holds them
# for work runs and the repository's modes that aren't light on their issues, pull requests and
# the comments there, for brainstorms on their own issue and its comments, and lets a run
# remove only the reactions it added (never the listener's on the comments that trigger runs).
package deckhand

# Work runs (a maintainer's, a review's fix run, a conflict's) and brainstorms acknowledge a
# comment with a reaction; the repository's own modes don't, unless it says so.
deny_github contains msg if {
  input.action in {"react", "unreact"}
  input.custom_mode
  msg := sprintf("a %s run doesn't react unless .deckhand/policy/gh-reactions.rego lets it", [input.mode])
}
