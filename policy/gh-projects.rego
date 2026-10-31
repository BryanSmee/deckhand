# Deckhand's default for runs adding their issues and pull requests to a project (v2), the
# `project` action (docs/repo-config.md#projects): work runs add their own issue, pull request,
# sub-issues and the issues they file, brainstorms the issues they file (their ceilings), to a
# project the operator grants the repository (`allow_projects`): it refuses nothing. The
# repository's own modes add items once its .deckhand/policy/ allows it (`allow_github`), within
# the work ceiling (a light one never). A grants folder's policy/gh-projects.rego replaces it, to
# refuse it to every run, say:
#
#   deny_github contains "runs don't add items to projects here" if input.action == "project"
#
# None reaches a project the grant doesn't name.
package deckhand
