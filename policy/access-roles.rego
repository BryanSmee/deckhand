# Deckhand's roles and bindings (docs/repo-config.md#access): who may do what on which repository
# (#730). A role is a set of actions; a binding gives a role (or its own `actions`) to some
# logins on some repositories, and `allow_access` gives the actions of every binding that matches.
# Deckhand's access.rego gives every action to every login instead; a grants folder's
# policy/access.rego replaces it, usually with `bindings` only:
#
#   package deckhand
#
#   bindings := [
#     {"users": ["alice"], "repos": ["acme/*"], "role": "viewer"},
#     {"users": ["bob"], "repos": ["acme/api", "acme/web"], "role": "member"},
#     {"users": ["carol"], "repos": ["*/*"], "role": "admin"},
#     {"users": ["carol"], "role": "operator"},
#   ]
#
# Logins and repositories match whatever their case. A repository's pattern: `owner/repo`,
# `owner/*` or `*/*`. Server-wide (no repository: input.repo is null), a binding of the user's
# matches whatever its `repos`, and gives its server actions (`server:…`) alone; on a repository,
# it gives the others. Deny rules (`deny_access`, of the operator's or a repository's
# .deckhand/policy/) take actions away; a deny always wins. Replacing this file replaces the
# roles too.
package deckhand

# Each role's actions. A `*` at the end gives every action that starts with what comes before it
# (`runs:start:*`: every mode).
access_roles := {
  "viewer": access_viewer,
  "member": access_member,
  "admin": access_admin,
  "operator": {"server:*"},
}

access_viewer := {"tasks:read"}

access_member := access_viewer | {"logs:read", "runs:start:*", "runs:manage"}

access_admin := access_member | {"repo:config:read"}

# `bindings`: none here, a grants folder's access.rego names them (read through `data`, so that
# none at all is no binding rather than an error).
allow_access contains action if {
  some binding in data.deckhand.bindings
  access_user(binding)
  access_where(binding)
  some action in access_actions(binding)
  access_scoped(action)
}

access_user(binding) if {
  some user in binding.users
  lower(user) == lower(input.user.login)
}

# Server-wide, every binding of the user's, for its `server:…` actions alone.
access_where(_) if input.repo == null

access_where(binding) if {
  input.repo != null
  some pattern in binding.repos
  access_repo(lower(pattern), lower(input.repo.name))
}

access_repo(pattern, name) if pattern == name

access_repo("*/*", _)

access_repo(pattern, name) if {
  endswith(pattern, "/*")
  pattern != "*/*"
  startswith(name, trim_suffix(pattern, "*"))
}

# Server-wide, the server's actions; on a repository, the others.
access_scoped(action) if {
  input.repo == null
  startswith(action, "server:")
}

access_scoped(action) if {
  input.repo != null
  not startswith(action, "server:")
}

# A role's actions, and a binding's own.
access_actions(binding) := access_roles[binding.role]

access_actions(binding) := {a | some a in binding.actions} if not binding.role
