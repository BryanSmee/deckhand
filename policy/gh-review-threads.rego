# Deckhand's default policy for review threads (`reply`, `resolve`, `unresolve`:
# docs/repo-config.md#the-default-policies). A grants folder's policy/gh-review-threads.rego
# replaces it, and a repository's .deckhand/policy/gh-review-threads.rego replaces both: never
# past the mode's ceiling, which holds these for work runs and the repository's modes that aren't
# light, on their own pull requests only.
package deckhand

# Work runs (a maintainer's, a review's fix run, a conflict's) answer the threads of their pull
# request; the repository's own modes don't, unless it says so.
deny_github contains msg if {
  input.action in {"reply", "resolve", "unresolve"}
  input.custom_mode
  msg := sprintf("a %s run doesn't answer review threads unless .deckhand/policy/gh-review-threads.rego lets it", [input.mode])
}

# Resolving hides a thread: a run resolves those Deckhand's review opened, never a person's,
# which stays open for its author to read the reply and resolve. Reopening one hides nothing.
deny_github contains msg if {
  input.action == "resolve"
  not input.target.thread.deckhand
  msg := sprintf("a run resolves only Deckhand's own review threads, not @%v's: reply instead", [input.target.thread.author])
}
