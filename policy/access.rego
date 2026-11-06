# Deckhand's default access (docs/repo-config/policies.md#access): every action, on every repository and
# server-wide, for every login ALLOWED_USERS lets in (sign-in, MCP, comments), as before access
# had rules (#730). A grants folder's policy/access.rego replaces it, usually with the `bindings`
# access-roles.rego reads: then each login has the actions of its bindings alone. A repository's
# .deckhand/policy/ may only take actions away (`deny_access`).
package deckhand

allow_access contains "*"
