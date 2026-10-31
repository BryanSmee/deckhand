# Deckhand's default for reactions (`react`, `unreact`: docs/repo-config.md#reactions): it
# refuses nothing. The mode's ceiling holds them for work runs and the repository's modes that
# aren't light on their issues, pull requests and the comments there, for brainstorms on their
# own issue and its comments, and lets a run remove only the reactions it added (never the
# listener's on the comments that trigger runs). The repository's own modes react once its
# .deckhand/policy/ allows it (`allow_github`). A grants folder's policy/gh-reactions.rego
# replaces it, to refuse reactions, say.
package deckhand
