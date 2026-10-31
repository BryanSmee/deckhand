# Deckhand's default for bug inbox entries, which read the code and file issues
# (docs/repo-config.md#the-default-policies): what their sandbox gets (`allow_capabilities`) and
# what they write to GitHub (`allow_github`). A grants folder's policy/mode-bug.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "bug"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}

# They file issues, parents with their sub-issues (prompts/bug.md), link those under the parents
# they filed, and create labels.
bug_writes := {
  "new_issue": {"create"},
  "created_issue": {"link"},
  "label": {"create"},
}

allow_github if {
  input.mode == "bug"
  every action in input.actions {
    action in bug_writes[input.target.kind]
  }
}

# Each issue they file carries the bug label: the inbox's triage finds it by it.
deny_github contains msg if {
  input.mode == "bug"
  input.target.kind == "new_issue"
  not "bug" in input.change.labels_added
  msg := "bug entries' issues carry the bug label"
}
