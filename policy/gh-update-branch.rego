# Deckhand's default for `gh pr update-branch` (`update_branch`:
# docs/repo-config.md#the-default-policies). A grants folder's policy/gh-update-branch.rego
# replaces it, and a repository's .deckhand/policy/gh-update-branch.rego replaces both: it
# broadens it or refuses it to every mode there (a linear history): never past the mode's
# ceiling, which holds it for work runs and the repository's modes that aren't light, on their
# own pull requests only, and always as a merge (github-pulls.mjs).
package deckhand

# Work runs (a maintainer's, a review's fix run, a conflict's) merge their base into their pull
# request's branch; the repository's own modes don't, unless it says so.
deny_github contains msg if {
  input.action == "update_branch"
  input.custom_mode
  msg := sprintf("a %s run doesn't update its pull request's branch unless .deckhand/policy/gh-update-branch.rego lets it", [input.mode])
}
