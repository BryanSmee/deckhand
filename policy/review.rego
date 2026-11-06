# Deckhand's default for the reviews that start by themselves (`deny_review`, `review.on: ready`:
# docs/repo-config/policies.md#the-default-policies). A grants folder's policy/review.rego replaces it:
# one with only `package deckhand` has every bot's ready pull requests reviewed, say. A
# repository's deny rules only add refusals. The built-in gate still holds: a person who opens
# one must be an allowed user, and a fork's is never reviewed.
package deckhand

# The allowlist lists people: another bot's pull request isn't reviewed by itself. Deckhand's
# own are.
deny_review contains msg if {
  input.pr.author_type == "Bot"
  not input.pr.deckhand
  msg := sprintf("%s is a bot: its pull requests aren't reviewed unless the operator's policy/review.rego lets them", [input.pr.author])
}
