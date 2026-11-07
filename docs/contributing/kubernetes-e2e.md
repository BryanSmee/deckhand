# Checking a cluster end to end

`deploy/kubernetes-e2e/run.sh` deploys the base on a cluster with this checkout's images, GitHub
and Anthropic replaced by fakes in a namespace of their own (`fakes.mjs`: GitHub's API and a
repository over git's smart HTTP, a scripted model, both over HTTPS from a CA the script makes),
then checks one run from start to end:

1. `check-isolation.sh` passes: a sandbox's pod reaches the egress proxy alone, not another
   sandbox's;
2. a signed comment on an issue, sent to edge, starts a sandbox pod, whose agent (Claude Code, at
   its pinned version) talks to the fake model through the models service;
3. a second comment is sent while the agent works, and every service is updated
   (`kubectl rollout restart`); the fake model keeps the agent working until the last rollout
   is done, each turn a command that calls GitHub through the egress proxy for 20 s
   (`git ls-remote`, and `gh api` through the GitHub gateway, every 2 s);
4. the reply is posted once and names the second comment, so it reached the agent;
5. none of the run's calls failed: no turn's command failed, the fake model got no call twice
   (Claude Code tries a failed API call again by itself), and the run's log has no retry or
   connection error;
6. no sandbox pod is left.

```sh
K3S=k3s deploy/kubernetes-e2e/run.sh   # in a k3s container on Docker, started if missing, then kept
deploy/kubernetes-e2e/run.sh           # on the cluster kubectl points at (images loaded on its nodes)
```

**Use it on a cluster you can throw away**, never on one with Deckhand installed. It installs
Deckhand, with settings and Secrets of its own, in the namespaces `deckhand`,
`deckhand-sandboxes` and `deckhand-e2e`, with the base's ClusterRoleBinding
`deckhand-broker-auth-delegator`, and deletes them when it ends, whatever the outcome. It labels
them `deckhand.e2e=true`, and refuses to start when one of them exists without that label (a
real install's would be overwritten, then deleted), or when the cluster can't say whether it
does. `KEEP=1` leaves them for a look, and the next run deletes them before it starts.

CI renders the overlay on every pull request without a cluster (#676): kubeconform validates it,
and `test/kubernetes-e2e-overlay.test.mjs` checks that it installs nothing outside those
namespaces and that binding, everything labelled, and that each of its patches still finds its
target in the base (kustomize skips one that doesn't, without a word). A change to the base that
breaks the check fails there, before anyone runs it.

It takes about five minutes on k3s, mostly building the images. It needs `docker`, `node` and
`openssl` where it runs, and `kubectl` without `K3S`. With `K3S` (or `PREINSTALL_AGENT=1`) it puts
Claude Code in the agent's claim beforehand
([Agents on Kubernetes](../kubernetes/sandboxes.md#agents-on-kubernetes)), so the cluster's pods
need no way to npm's registry; otherwise the run installs it through the egress proxy. No CI job
runs it: k3s needs a privileged container. With `K3S`, the k3s container (privileged) stays for the
next run, its images loaded: `docker rm -f k3s` removes it.
