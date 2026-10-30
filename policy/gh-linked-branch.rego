# Deckhand's default for the branch the listener links to a run's issue as the run starts
# (docs/repo-config.md#the-linked-branch-input): work runs only (a fix or conflict run's branch
# exists already, so nothing is linked for it). A grants folder's policy/gh-linked-branch.rego
# replaces it, and a repository's .deckhand/policy/gh-linked-branch.rego replaces both.
package deckhand

deny_link_branch contains msg if {
  input.custom_mode
  msg := sprintf("mode %s doesn't link a branch to its issue unless .deckhand/policy/gh-linked-branch.rego allows it", [input.mode])
}

deny_link_branch contains msg if {
  not input.custom_mode
  input.mode != "work"
  msg := sprintf("%s runs don't link a branch to their issue", [input.mode])
}
