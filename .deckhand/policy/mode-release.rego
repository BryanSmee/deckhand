# Repository mode: prepare a release; publishing stays with the maintainer.
package deckhand

allow_run if {
  input.mode == "release"
  input.target.kind == "issue"
}

# A reply that continues the issue's run, posted on its prepare pull request (where its replies
# go since #1054) as well as on the issue.
allow_run if {
  input.mode == "release"
  input.continues
}

allow_capabilities contains c if {
  input.mode == "release"
  some c in {"pull", "push", "setup", "read:issues", "read:pulls", "read:actions"}
}

# The gateway also checks ownership and refuses tags, releases and merges before policy.
# No ready, closing, assignment, comments, or writes to unrelated issues; reactions only on its
# own issue and pull request (the sandbox's rules suggest them for comments needing no answer).
release_writes := {
  "own_issue": {"edit", "link", "react", "unreact"},
  "own_pr": {"edit", "draft", "milestone", "react", "unreact"},
  "new_pr": {"create", "milestone"},
  "new_issue": {"create", "milestone"},
  "created_issue": {"edit", "link", "milestone"},
  "sub_issue": {"link"},
}

allow_github if {
  input.mode == "release"
  count(input.actions) > 0
  every action in input.actions {
    action in release_writes[input.target.kind]
  }
}

allow_github if {
  input.mode == "release"
  input.action == "read_checks"
}

allow_push if {
  input.mode == "release"
  input.action == "push"
  startswith(input.branch, sprintf("issue-%d-", [input.issue]))
  input.ref == sprintf("refs/heads/%s", [input.branch])
  input.branch != input.default_branch
  not input.deleted
}
