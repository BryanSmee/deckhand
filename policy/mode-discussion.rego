# Deckhand's default for discussion runs, which read the code and answer in the discussion
# (docs/repo-config/policies.md#the-default-policies): what their sandbox gets (`allow_capabilities`) and
# what they write to GitHub (`allow_github`). The listener posts their answer. A grants folder's
# policy/mode-discussion.rego replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "discussion"
  some c in {
    "pull",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:discussions",
    "read:actions",
  }
}

# They file the issues a discussion settles on.
allow_github if {
  input.mode == "discussion"
  input.actions == ["create"]
  input.target.kind == "new_issue"
}
