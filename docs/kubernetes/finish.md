# Finishing the install

After [Install with Helm](helm.md) or [Install with kustomize](install.md): neither the chart nor
the base holds a Secret, so the pods wait for these.

## The Secrets

The base doesn't hold them. Each is one service's alone:

```sh
# The broker's signing key, its public key (a ConfigMap, nothing secret, mounted read only by
# the services that check tokens offline), and models.key. Once: new keys would refuse the
# running sandboxes' tokens and the sealed plan logins.
node deploy/kubernetes/secrets.mjs keys | kubectl apply -f -
# Your agents' credentials, the models service's alone (docs/guides/agents.md).
kubectl -n deckhand create secret generic deckhand-models \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token>
# Optional: the plans' logins (codex-auth.json, agy-auth.json: guides/agents.md#the-credentials-folder).
kubectl -n deckhand create secret generic deckhand-credentials --from-file=codex-auth.json
```

## The GitHub App

On a cluster, edge and the github service read the App's credentials
from Secrets, read only, so `/setup` stays closed. `secrets.mjs app` runs the same manifest flow
from your machine: open the address it prints, create the App on GitHub, and it prints edge's
Secret (the webhook secret, the OAuth client's, a new session key) and the github service's (the
App's key) for `kubectl`:

```sh
node deploy/kubernetes/secrets.mjs app --url https://deckhand.example.com [--org acme] \
  | kubectl apply -f -
```

Then install the App on your repositories (the page it ends on links there). Back up the three
Secrets (`deckhand-edge`, `deckhand-github`, `deckhand-broker-key`) with `deckhand-models-key`:
without them, Deckhand can't act as the App, check GitHub's webhooks, or renew the running
sandboxes' tokens. To change the App, delete `deckhand-edge` and `deckhand-github`, make them
again, and restart edge and the github service (`kubectl -n deckhand rollout restart deploy/edge
deploy/github`).

## Checking the isolation

Once every pod is ready (`kubectl -n deckhand get pods`):

```sh
sh deploy/kubernetes/check-isolation.sh
```

It starts a pod labelled as a sandbox in `deckhand-sandboxes`, tries every port of every service's
pod from there (their [metrics](metrics.md#metrics) port too), the egress proxy's, and a second
sandbox's pod it starts beside it, listening, and expects the proxy's alone to answer: 3128, and
3129 too when its Service publishes it (the `engine` component). A plugin that doesn't enforce
NetworkPolicies fails it. The runner makes a check of its own as it starts
([The network probe](isolation.md#the-network-probe)): its log says what it found. Then mention
Deckhand on an issue ([Start runs](../guides/runs.md)): its first run starts a sandbox pod.
