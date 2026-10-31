# Deckhand's default policy for rerunning failed GitHub Actions jobs (`gh run rerun --failed`,
# docs/repo-config.md#reruns): the ceiling lets work runs rerun those of their own pull request's
# head, at most twice per head commit; this narrows it to a first rerun (GitHub's first attempt
# failed). A grants folder's policy/gh-actions-rerun.rego replaces it. The repository's own modes
# rerun only once its .deckhand/policy/ allows it (`allow_github`).
package deckhand

deny_github contains msg if {
  input.action == "rerun"
  input.target.attempt != 1
  msg := sprintf("a workflow run is rerun once: run %d is on its attempt %d", [input.target.run_id, input.target.attempt])
}
