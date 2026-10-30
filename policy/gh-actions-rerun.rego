# Deckhand's default policy for rerunning failed GitHub Actions jobs (`gh run rerun --failed`,
# docs/repo-config.md#reruns): the ceiling lets work runs rerun those of their own pull request's
# head, at most twice per head commit; this narrows it to a first rerun (GitHub's first attempt
# failed), and none for the repository's own modes. A grants folder's
# policy/gh-actions-rerun.rego replaces it, and a repository's
# .deckhand/policy/gh-actions-rerun.rego replaces both.
package deckhand

deny_github contains msg if {
  input.action == "rerun"
  input.custom_mode
  msg := sprintf("%s runs don't rerun GitHub Actions jobs here", [input.mode])
}

deny_github contains msg if {
  input.action == "rerun"
  input.target.attempt != 1
  msg := sprintf("a workflow run is rerun once: run %d is on its attempt %d", [input.target.run_id, input.target.attempt])
}
