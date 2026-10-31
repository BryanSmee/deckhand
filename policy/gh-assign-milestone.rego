# Deckhand's default for assignees and milestones (`assign`, `milestone`:
# docs/repo-config.md#assignees-and-milestones). A grants folder's
# policy/gh-assign-milestone.rego replaces it: never past the mode's ceiling, which holds them
# for work runs and the repository's modes that aren't light (their issue and pull requests, its
# sub-issues, the issues they file), and the milestone of the issues a brainstorm files; nor
# past the built-in limit on assignees (the repository's allowed users or the App's bot, never
# Copilot). Work runs and brainstorms set milestones; the repository's own modes once its
# .deckhand/policy/ allows it (`allow_github`).
package deckhand

# An assignment notifies people: no run assigns, unless the operator's policies say so.
deny_github contains msg if {
  "assign" in input.actions
  msg := "a run doesn't assign people unless the operator's policy/gh-assign-milestone.rego lets it"
}
