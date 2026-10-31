# Deckhand's default policy for review threads (`reply`, `resolve`, `unresolve`:
# docs/repo-config.md#the-default-policies). A grants folder's policy/gh-review-threads.rego
# replaces it: never past the mode's ceiling, which holds these for work runs and the
# repository's modes that aren't light, on their own pull requests only. Work runs (a
# maintainer's, a review's fix run, a conflict's) answer the threads of their pull request; the
# repository's own modes once its .deckhand/policy/ allows it (`allow_github`).
package deckhand

# Resolving hides a thread: a run resolves those Deckhand's review opened, never a person's,
# which stays open for its author to read the reply and resolve. Reopening one hides nothing.
deny_github contains msg if {
  input.action == "resolve"
  not input.target.thread.deckhand
  msg := sprintf("a run resolves only Deckhand's own review threads, not @%v's: reply instead", [input.target.thread.author])
}
