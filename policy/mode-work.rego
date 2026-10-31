# Deckhand's default capabilities for work runs (a maintainer's, a review's fix run, a CI fix, a
# conflict's) and the repository's own modes (docs/repo-config.md#capabilities): what their
# sandbox gets. A grants folder's policy/mode-work.rego replaces it. The repository's own modes
# get at most these, and only those its .deckhand/policy/ allows too (`allow_capabilities`).
package deckhand

work_capabilities := {
  "pull",
  "push",
  "setup",
  "image:repo",
  "image:branch",
  "docker",
  "preview",
  "read:issues",
  "read:pulls",
  "read:discussions",
  "read:actions",
}

allow_capabilities contains c if {
  input.mode == "work"
  some c in work_capabilities
}

allow_capabilities contains c if {
  input.custom_mode
  some c in work_capabilities
}
