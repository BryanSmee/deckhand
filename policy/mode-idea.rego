# Deckhand's default for idea inbox entries, which read the code and file issues
# (docs/repo-config.md#the-default-policies): what their sandbox gets (`allow_capabilities`) and
# what they write to GitHub (`allow_github`). A grants folder's policy/mode-idea.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "idea"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
  }
}

# They file issues, parents with their sub-issues (prompts/idea.md), link those under the parents
# they filed, and create labels.
idea_writes := {
  "new_issue": {"create"},
  "created_issue": {"link"},
  "label": {"create"},
}

allow_github if {
  input.mode == "idea"
  every action in input.actions {
    action in idea_writes[input.target.kind]
  }
}

# Each issue they file carries the idea label: the inbox's triage finds it by it.
deny_github contains msg if {
  input.mode == "idea"
  input.target.kind == "new_issue"
  not "idea" in input.change.labels_added
  msg := "idea entries' issues carry the idea label"
}
