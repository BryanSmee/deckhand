# Deckhand's default policy for the reviewers the listener requests on Deckhand's pull requests
# (`review.request`, docs/repo-config.md#reviewers): on work runs' pull requests (work, fix and
# conflict runs), when they turn ready and after a fix; on those of the repository's own modes
# once its .deckhand/policy/ allows it (`allow_request_review`). A grants folder's
# policy/gh-reviewers.rego replaces it.
package deckhand

# Brainstorms, research and the other built-in modes open no pull request.
deny_request_review contains msg if {
  not input.custom_mode
  is_string(input.mode)
  input.mode != "work"
  msg := sprintf("reviewers are requested only on work runs' pull requests, not on a %s run's", [input.mode])
}

# Nor on one whose run the listener no longer knows.
deny_request_review contains "the run whose pull request it is isn't known" if input.mode == null
