# Deckhand's default for assignees and milestones (`assign`, `milestone`:
# docs/repo-config.md#assignees-and-milestones). A grants folder's
# policy/gh-assign-milestone.rego replaces it, and a repository's
# .deckhand/policy/gh-assign-milestone.rego replaces both: never past the mode's ceiling, which
# holds them for work runs and the repository's modes that aren't light (their issue and pull
# requests, its sub-issues, the issues they file), and the milestone of the issues a brainstorm
# files; nor past the built-in limit on assignees (the repository's allowed users or the App's
# bot, never Copilot).
package deckhand

# An assignment notifies people: no run assigns, unless the repository says so.
deny_github contains msg if {
  "assign" in input.actions
  msg := "a run doesn't assign people unless .deckhand/policy/gh-assign-milestone.rego lets it"
}

# Work runs (a maintainer's, a review's fix run, a conflict's) and brainstorms set milestones;
# the repository's own modes don't, unless it says so.
deny_github contains msg if {
  "milestone" in input.actions
  input.custom_mode
  msg := sprintf("a %s run doesn't set milestones unless .deckhand/policy/gh-assign-milestone.rego lets it", [input.mode])
}
