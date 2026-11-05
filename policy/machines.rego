# Deckhand's default for the pull requests the App opened from a user's machine's push
# (`pr.external`, #598: docs/repo-config.md#machinesrego). Their commits never went through the
# git gateway's checks (its refs, `allow_push`, the workflow files): the review is their check,
# and a person merges them. A grants folder's policy/machines.rego replaces it: one with only
# `package deckhand` lets `review.merge` merge them as any of Deckhand's own. A repository's deny
# rules only add refusals.
package deckhand

deny_merge contains msg if {
  is_string(input.pr.external)
  msg := sprintf("its commits were pushed from %s's machine, not through Deckhand: a person merges it", [input.pr.external])
}
