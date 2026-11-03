# What the operator grants each repository beyond hosts, mounts and limits (#498,
# docs/security.md#the-grants): one `allow_grant` rule per set of repositories, asked with
# input.grant (the grant's name) and input.repo.name (lower case). Nothing granted unless a rule
# here says so; a `deny_grant` rule wins over them. Read again at each decision: an edit applies
# without a restart. A repository's own policies never grant these.
package deckhand

# Its .deckhand.yaml's `dockerfile` built on the host's Docker, and `/mode research` runs (any
# public host, without its code).
# allow_grant if {
#   input.repo.name == "your-org/your-repo"
#   input.grant in {"dockerfile", "research"}
# }

# Granted one repository at a time only: list each input.repo.name (a rule that also matches
# "*/*" or "<owner>/*", as one for every repository or an owner's prefix does, gives them to none;
# a check at best, other wide rules aren't caught): `docker` (a container engine next to its
# sandboxes), `workflows` (its pushes may change .github/workflows/), `workflow_secrets` (with
# `workflows`, its workflows that only run from the default branch may use secrets) and
# `auto_merge` (UNSAFE:
# `review.merge` merges Deckhand's pull requests with no human reading them; `auto_merge_public`
# on a public repository too). `branch_docker_images`: its pull requests' runs build their
# branch's Dockerfile.
# allow_grant if {
#   input.repo.name == "your-org/your-repo"
#   input.grant in {"docker", "workflows", "branch_docker_images"}
# }
