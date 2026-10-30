# Deckhand's default for runs adding their issues and pull requests to a project (v2), the
# `project` action (docs/repo-config.md#projects): work runs add their own issue, pull request,
# sub-issues and the issues they file, brainstorms the issues they file (their ceilings), to a
# project the operator grants the repository (`allow_projects`). The repository's own modes
# don't. A repository's .deckhand/policy/gh-projects.rego replaces this file: it can let its
# modes add items too (within the work ceiling, a light one never), or refuse them to every run,
# but never reach a project the grant doesn't name.
package deckhand

deny_github contains msg if {
  input.action == "project"
  input.custom_mode
  msg := sprintf("mode %s doesn't add items to projects unless .deckhand/policy/gh-projects.rego allows it", [input.mode])
}
