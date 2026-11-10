# Deckhand's default for groomings and their wrap-up (`/stop` on a grooming issue), which read
# the code and every issue and answer, without a branch or the repository's setup, like a
# brainstorm (docs/repo-config/policies.md#the-default-policies): what their sandbox gets
# (`allow_capabilities`) and what they write to GitHub (`allow_github`). The first default mode
# that writes to issues it didn't create (#585). A grants folder's policy/mode-grooming.rego
# replaces it.
package deckhand

grooming if input.mode in {"grooming", "grooming-stop"}

allow_capabilities contains c if {
  grooming
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
    "read:context",
  }
}

# Both edit their own issue's description (the pass's log), react there, file the issues that
# replace merged or rewritten ones (with a milestone), and create labels. They comment on the
# issues they review; the wrap-up also edits, labels and closes them, as agreed.
grooming_writes := {
  "own_issue": {"edit", "link", "react", "unreact"},
  "new_issue": {"create", "milestone"},
  "label": {"create"},
  "other_issue": {"comment"},
  "sub_issue": {"comment"},
  "created_issue": {"comment"},
}

grooming_wrap_up := {"comment", "edit", "label", "close"}

allow_github if {
  grooming
  every action in input.actions {
    action in grooming_writes[input.target.kind]
  }
}

allow_github if {
  input.mode == "grooming-stop"
  input.target.kind in {"other_issue", "sub_issue", "created_issue"}
  every action in input.actions {
    action in grooming_wrap_up
  }
}

# The listener posts their replies on their own issue.
deny_github contains msg if {
  grooming
  input.action == "comment"
  input.target.kind == "own_issue"
  msg := "a grooming doesn't comment on its own issue: its final message is posted as its reply"
}

# An issue it closes isn't done by its hand: not planned, or a duplicate (`state_reason`; one
# without it is GitHub's `completed`).
deny_github contains msg if {
  grooming
  "close" in input.actions
  not grooming_closes_as_agreed
  msg := "a grooming closes an issue as not planned or as a duplicate only"
}

grooming_closes_as_agreed if input.change.state_reason in {"not_planned", "duplicate"}
