# Deckhand's default allow rules (docs/repo-config.md#the-default-policies). A decision is
# refused unless an allow rule of the operator's policies matches it: these allow each one, so
# that the modes' built-in ceilings (listener/modes.mjs) and the deny rules of the other files
# decide, as before allow rules existed. A grants folder's policy/allow.rego replaces it (one
# without `allow_merge` refuses every auto-merge, say), and its other files add allow rules. A
# repository's own modes also need an allow rule of the repository's (.deckhand/policy/).
package deckhand

allow_merge := true

allow_review := true

allow_fix := true

allow_link_branch := true

allow_request_review := true

allow_github := true
