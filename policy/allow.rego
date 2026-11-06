# Deckhand's default allow rules (docs/repo-config/policies.md#the-default-policies). A decision is
# refused unless an allow rule of the operator's policies matches it: these allow each of the
# listener's own decisions, which the deny rules of the other files narrow. Not `allow_run`
# (run.rego allows each mode where it makes sense), nor what a run gets and does: each mode's
# file, mode-<mode>.rego, allows its capabilities (`allow_capabilities`), its GitHub writes
# (`allow_github`) and its pushes (`allow_push`). A grants folder's policy/allow.rego replaces
# it (one without `allow_merge` refuses every auto-merge, say), and its other files add allow
# rules. A repository's own modes also need an allow rule of the repository's
# (.deckhand/policy/).
package deckhand

allow_merge := true

allow_review := true

allow_fix := true

allow_link_branch := true

allow_request_review := true
