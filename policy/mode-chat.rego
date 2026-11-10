# Deckhand's default for chats, the conversations a user starts from the dashboard
# (docs/repo-config/policies.md#the-default-policies): what their sandbox gets (`allow_capabilities`). They
# read the code, run the repository's setup and read its issues, pull requests and CI, without a
# branch or a container engine. No `allow_github` nor `allow_push`: GitHub refuses every write of
# theirs, and their answers stay in the conversation. A grants folder's policy/mode-chat.rego
# replaces it.
package deckhand

allow_capabilities contains c if {
  input.mode == "chat"
  some c in {
    "pull",
    "setup",
    "image:repo",
    "read:issues",
    "read:pulls",
    "read:actions",
    "read:context",
  }
}
