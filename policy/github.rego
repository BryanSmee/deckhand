# Deckhand's default policy for a run's GitHub writes (docs/repo-config.md#the-default-policies):
# the modes' ceilings leave room for what a prompt may need one day, this narrows them to what
# Deckhand's prompts ask for. A grants folder's policy/github.rego replaces it, and a
# repository's .deckhand/policy/github.rego replaces both.
package deckhand

# Brainstorms edit their own issue's description, and file and link their follow-ups: the
# listener posts their replies, so they comment nowhere, and write to no other issue.
deny_github contains msg if {
  input.mode in {"brainstorm", "stop"}
  input.action == "comment"
  msg := "a brainstorm doesn't comment: its final message is posted as its reply"
}

deny_github contains msg if {
  input.mode in {"brainstorm", "stop"}
  not input.target.kind in {"own_issue", "new_issue", "label"}
  not orders_follow_ups
  not files_follow_ups
  msg := sprintf("a brainstorm writes only its own issue, not #%d", [input.target.number])
}

# But it orders its follow-ups: "blocked by" links on its sub-issues and the issues it filed.
orders_follow_ups if {
  input.action == "link"
  input.change.blocked_by
  input.target.kind in {"sub_issue", "created_issue"}
}

# And puts the issues it filed on a granted project (gh-projects.rego, its ceiling).
files_follow_ups if {
  input.action == "project"
  input.target.kind == "created_issue"
}

# And puts the issues it filed in a milestone (their ceiling: nothing else of theirs).
orders_follow_ups if {
  input.actions == ["milestone"]
  input.target.kind == "created_issue"
}

# Inbox entries only file issues (with their label), and link the ones they split.
deny_github contains msg if {
  input.mode in {"idea", "bug"}
  not input.action in {"create", "link"}
  msg := sprintf("%s entries only file issues", [input.mode])
}

deny_github contains msg if {
  input.mode in {"idea", "bug"}
  input.target.kind == "new_issue"
  not input.mode in input.change.labels_added
  msg := sprintf("%s entries' issues carry the %s label", [input.mode, input.mode])
}
