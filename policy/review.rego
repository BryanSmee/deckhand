# Deckhand's default for the reviews that start by themselves (`deny_review`, `review.on: ready`:
# docs/repo-config.md#the-default-policies). A grants folder's policy/review.rego replaces it,
# and a repository's .deckhand/policy/review.rego replaces both: one with only
# `package deckhand` has Dependabot's ready pull requests reviewed, say. The built-in gate still
# holds: a person who opens one must be an allowed user, and a fork's is never reviewed.
package deckhand

# The allowlist lists people: another bot's pull request isn't reviewed by itself. Deckhand's
# own are.
deny_review contains msg if {
  input.pr.author_type == "Bot"
  not input.pr.deckhand
  msg := sprintf("%s is a bot: its pull requests aren't reviewed unless .deckhand/policy/review.rego lets them", [input.pr.author])
}
