# Deckhand's default for reading CI's results beyond GitHub Actions
# (docs/repo-config/policy-inputs.md#reading-cis-checks): check runs and suites and commit statuses, `gh pr
# checks`, which `allow_github` and `deny_github` see as `read_checks`. It is a read, allowed in
# every mode with a token (research gets none), the repository's own modes once its
# .deckhand/policy/ allows it too. A grants folder's policy/gh-checks.rego replaces it, and a
# repository refuses it to its runs with a deny rule of its own in .deckhand/policy/, say:
#
#   deny_github contains "this repository's runs don't read CI's checks" if {
#     input.action == "read_checks"
#   }
package deckhand

allow_github if input.action == "read_checks"
