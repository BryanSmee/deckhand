# Deckhand's default for `gh pr update-branch` (`update_branch`:
# docs/repo-config.md#the-default-policies): it refuses nothing. The mode's ceiling holds it for
# work runs and the repository's modes that aren't light, on their own pull requests only, and
# always as a merge (github-pulls.mjs). Work runs (a maintainer's, a review's fix run, a
# conflict's) merge their base into their pull request's branch; the repository's own modes once
# its .deckhand/policy/ allows it (`allow_github`). A grants folder's policy/gh-update-branch.rego
# replaces it, and a repository refuses it to every run with a deny rule of its own (a linear
# history).
package deckhand
