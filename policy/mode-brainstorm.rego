# Deckhand's default for brainstorms and their wrap-up (`/stop`), which read the code and the
# issues and answer, without a branch or the repository's setup
# (docs/repo-config.md#the-default-policies): what their sandbox gets (`allow_capabilities`) and
# what they write to GitHub (`allow_github`). A grants folder's policy/mode-brainstorm.rego
# replaces it.
package deckhand

brainstorm if input.mode in {"brainstorm", "stop"}

allow_capabilities contains c if {
  brainstorm
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}

# They edit their own issue's description, react there, file their follow-ups (with a
# milestone) and link them under it, and create labels.
brainstorm_writes := {
  "own_issue": {"edit", "link", "react", "unreact"},
  "new_issue": {"create", "milestone"},
  "label": {"create"},
}

allow_github if {
  brainstorm
  every action in input.actions {
    action in brainstorm_writes[input.target.kind]
  }
}

# They order their follow-ups: "blocked by" links on its sub-issues and the issues it filed.
allow_github if {
  brainstorm
  input.actions == ["link"]
  input.change.blocked_by
  input.target.kind in {"sub_issue", "created_issue"}
}

# They put the issues they filed on a project the operator grants, or in a milestone: nothing
# else of theirs.
allow_github if {
  brainstorm
  input.actions in {["project"], ["milestone"]}
  input.target.kind == "created_issue"
}

# Their token reads the organization's projects, where the operator grants the repository one.
allow_github if {
  brainstorm
  input.action == "read_projects"
}

# The listener posts their replies: they comment nowhere.
deny_github contains msg if {
  brainstorm
  input.action == "comment"
  msg := "a brainstorm doesn't comment: its final message is posted as its reply"
}
