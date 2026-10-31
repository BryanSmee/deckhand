# Deckhand's default for the branch the listener links to a run's issue as the run starts
# (docs/repo-config.md#the-linked-branch-input): work runs only (a fix or conflict run's branch
# exists already, so nothing is linked for it) among the built-in modes. A grants folder's
# policy/gh-linked-branch.rego replaces it. The repository's own modes link one once its
# .deckhand/policy/ allows it (`allow_link_branch`).
package deckhand

deny_link_branch contains msg if {
  not input.custom_mode
  input.mode != "work"
  msg := sprintf("%s runs don't link a branch to their issue", [input.mode])
}
