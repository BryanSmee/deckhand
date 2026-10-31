# policy/gh-checks.rego
# Deckhand's default for reading CI's results beyond GitHub Actions (docs/repo-config.md#the-default-policies):
# check runs and suites and commit statuses, `gh pr checks`, which deny_github sees as
# `read_checks`. It is a read, allowed everywhere a run has a token: work, fix and conflict
# runs, brainstorms, and the repository's own modes once its .deckhand/policy/ allows it
# (`allow_github`; research gets no token). A grants folder's policy/gh-checks.rego replaces
# it, and a repository refuses it to its runs with a deny rule of its own in
# .deckhand/policy/, say:
#
#   deny_github contains "this repository's runs don't read CI's checks" if {
#     input.action == "read_checks"
#   }
package deckhand
