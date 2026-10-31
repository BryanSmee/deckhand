# Deckhand's default for work runs (a maintainer's, a review's fix run, a CI fix, a conflict's)
# and the repository's own modes that aren't light (docs/repo-config.md#the-default-policies):
# what their sandbox gets (`allow_capabilities`), what they write to GitHub (`allow_github`) and
# where they push (`allow_push`). A grants folder's policy/mode-work.rego replaces it. The
# repository's own modes get at most these, and only what its .deckhand/policy/ allows too.
package deckhand

work_capabilities := {
  "pull",
  "push",
  "setup",
  "image:repo",
  "image:branch",
  "docker",
  "preview",
  "read:issues",
  "read:pulls",
  "read:actions",
}

allow_capabilities contains c if {
  input.mode == "work"
  some c in work_capabilities
}

allow_capabilities contains c if {
  input.custom_mode
  some c in work_capabilities
}

# The runs this file's writes are for.
work_run if input.mode == "work"

work_run if {
  input.custom_mode
  not input.light
}

# What they write, by the target's kind (docs/repo-config.md#the-github-input): their issue,
# its sub-issues and the issues they file (`label`: issue #443; `react`, `unreact`: #458;
# `project`: #454, to a project the operator grants; `assign`, `milestone`: #453), their pull
# requests (`ready`, `draft`: #407; `update_branch`: #456, as a merge; `reply`, `resolve`,
# `unresolve` their review threads: #449; `rerun` their head's failed GitHub Actions jobs: #451),
# the comments they posted (#455), new issues and pull requests, and labels. Never a review, a
# merge, closing or locking, nor a label's or the repository's settings: no rule allows them.
work_writes := {
  "own_issue": {"edit", "comment", "label", "link", "react", "unreact", "project", "assign", "milestone"},
  "own_pr": {
    "edit", "comment", "label", "ready", "draft", "update_branch", "react", "unreact",
    "reply", "resolve", "unresolve", "rerun", "project", "assign", "milestone",
  },
  "sub_issue": {"edit", "comment", "label", "link", "react", "unreact", "project", "assign", "milestone"},
  "created_issue": {"edit", "comment", "label", "link", "react", "unreact", "project", "assign", "milestone"},
  "created_comment": {"edit", "delete"},
  "new_issue": {"create", "assign", "milestone"},
  "new_pr": {"create", "assign", "milestone"},
  "label": {"create"},
}

allow_github if {
  work_run
  every action in input.actions {
    action in work_writes[input.target.kind]
  }
}

# Their token reads the organization's projects, where the operator grants the repository one:
# `gh project item-add` looks the project up before it adds an item.
allow_github if {
  work_run
  input.action == "read_projects"
}

# They push their own branches (the git gateway's checks: never the default branch, nor another
# task's).
allow_push if work_run

# A deleted comment leaves no trace of what it said: a run edits its mistake instead.
deny_github contains msg if {
  input.target.kind == "created_comment"
  input.action == "delete"
  msg := "a run doesn't delete its comments unless the operator's policies let it: edit yours instead"
}

# Resolving hides a thread: a run resolves those Deckhand's review opened, never a person's,
# which stays open for its author to read the reply and resolve. Reopening one hides nothing.
deny_github contains msg if {
  input.action == "resolve"
  not input.target.thread.deckhand
  msg := sprintf("a run resolves only Deckhand's own review threads, not @%v's: reply instead", [input.target.thread.author])
}

# An assignment notifies people: no run assigns, unless the operator's policies say so.
deny_github contains msg if {
  "assign" in input.actions
  msg := "a run doesn't assign people unless the operator's policy/mode-work.rego lets it"
}

# A workflow run is rerun once: GitHub's first attempt failed (`gh run rerun --failed`).
deny_github contains msg if {
  input.action == "rerun"
  input.target.attempt != 1
  msg := sprintf("a workflow run is rerun once: run %d is on its attempt %d", [input.target.run_id, input.target.attempt])
}
