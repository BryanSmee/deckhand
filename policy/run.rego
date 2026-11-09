# Deckhand's default for the runs a person starts (`allow_run`: docs/repo-config/policy-inputs.md#the-run-input):
# each mode where it makes sense. A grants folder's policy/run.rego replaces it (one that also
# allows brainstorms on pull requests, say, or only some people's work runs); a repository's
# deny rules only add refusals, and its own modes also need its allow rule
# (.deckhand/policy/). The listener's own runs (reviews, fix, CI fix and conflict runs) aren't
# asked: `allow_review` and `allow_fix` decide those. With this file unchanged and nothing
# added, the listener decides as it would without asking opa (listener/run-policy.mjs
# defaultRun(), which its tests compare with this file).
package deckhand

# Every mode runs on an issue; on a pull request or a discussion, all but these.
allow_run if input.target.kind == "issue"

# Brainstorms, groomings, their wrap-ups (`/stop`) and onboarding are conversations on an issue:
# a pull request's comments are about its code.
allow_run if not input.mode in {"brainstorm", "stop", "grooming", "grooming-stop", "onboarding"}

# A comment that goes on in the issue's current mode, without a trigger or `/mode` line: the
# conversation started where it was allowed (the onboarding pull request's comments go on in
# onboarding).
allow_run if input.continues
