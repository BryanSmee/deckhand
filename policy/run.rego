# Deckhand's default for the runs a person starts (`allow_run`: docs/repo-config.md#the-run-input):
# each mode where it makes sense. A grants folder's policy/run.rego replaces it (one that also
# allows brainstorms on pull requests, say, or only some people's work runs); a repository's
# deny rules only add refusals, and its own modes also need its allow rule
# (.deckhand/policy/). The listener's own runs (reviews, fix, CI fix and conflict runs) aren't
# asked: `allow_review` and `allow_fix` decide those.
package deckhand

# Every mode runs on an issue; on a pull request or a discussion, all but these.
allow_run if input.target.kind == "issue"

# Brainstorms, their wrap-up (`/stop`) and onboarding are conversations on an issue: a pull
# request's comments are about its code.
allow_run if not input.mode in {"brainstorm", "stop", "onboarding"}
