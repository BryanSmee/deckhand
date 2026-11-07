# Security policy

Deckhand runs an agent without permission prompts on text other people wrote, so its isolation
is the product: a way around it is a vulnerability, even when it needs an unusual setup.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: the **Security** tab of
[BryanSmee/deckhand](https://github.com/BryanSmee/deckhand/security), then **Report a
vulnerability**. Only the maintainer reads it there, and the fix and its advisory are prepared
in a private fork before anything is public.

Please don't open a public issue, pull request or discussion about it, and don't ask a Deckhand
run about it in a comment: what a run reads and writes on GitHub is public on a public
repository. If the button isn't there, open an issue that says only that you have a security
report and asks for a private way to send it, without any detail.

A useful report says:

- the version (the image tag, or the commit) and how it is deployed (Docker Compose or
  Kubernetes, with Sysbox, Podman or no container engine);
- the settings and grants it needs (`ALLOWED_USERS`, the repository's `.deckhand.yaml`, the
  grants folder), without their secrets;
- who the attacker is (anyone who can open an issue, an allowed user, a fork's code, code
  running in a sandbox, a machine) and what they get;
- the steps, or a proof of concept.

The maintainer answers there, and keeps you posted until it is fixed. Once the fix is
released, the advisory credits you, unless you'd rather it didn't.

## Scope

In scope: anything that lets someone do more than [docs/security.md](docs/security.md) says
they can, in any of Deckhand's parts:

- **edge**: webhooks and their HMAC, the dashboard's sign-in and sessions, the MCP clients'
  OAuth, the screenshots it serves;
- **the orchestrator**: who starts a run, the per-repository config narrowing the operator's
  settings, the queue and the runs' state;
- **the github service** and its **GitHub and git gateways**: the App's key and installation
  tokens, the writes and pushes a run is allowed, the secrets redacted from what it writes;
- **the runner**: the sandbox specs checked against the grants, mounts, image builds, the
  Docker socket or the Kubernetes API;
- **the broker**: the run tokens and their signing key, a run's inbox and files;
- **the models service**: the agents' credentials and logins, which run gets which;
- **the policy service** and Deckhand's default policies (`policy/`): grants, capabilities,
  writes and pushes allowed that shouldn't be;
- **the egress proxy**: hosts a run reaches that it wasn't granted, its CA, its cache;
- **the sandbox's isolation**: escaping the container, reaching another run, the host or a
  service directly, keeping a token past its run;
- **the machine driver** (`machine/deckhand-machine.mjs`): what the App or another user can
  make it do on a user's machine;
- the Kubernetes manifests and Helm chart (`deploy/`), where their defaults weaken any of the
  above.

Out of scope:

- What [docs/security.md](docs/security.md) already lists as accepted or not covered (its
  [Not covered](docs/security/not-covered.md) page): image builds and the agents' install outside the sandboxes' networks,
  DNS lookups leaving the internal networks, data sent to a host the operator granted.
- A deployment the operator configured against the docs: a grant marked UNSAFE, a host mount
  of a secret, an allowlist that lets strangers start runs.
- What a run's agent does with what it was allowed: an operator who grants a host trusts it.
- Vulnerabilities in GitHub, Docker, Kubernetes, Claude Code or the other agents themselves:
  report them to their makers (tell us too if Deckhand should work around one).

## Supported versions

Fixes go into the next release; only the latest release is supported. Update with
`docker compose pull` (or your chart's or manifests' new version), as
[Updating](docs/guides/updating.md) says.
