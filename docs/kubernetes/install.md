# Install with kustomize

The kustomize base, `deploy/kubernetes/`, with your settings in an overlay of your own. Read the
[requirements](../kubernetes.md#requirements) first; [Install with Helm](helm.md) does the same
with the chart's values.

## 1. Your overlay

Keep your settings in a folder of your own (a git repository), whose
`kustomization.yaml` takes the base at a release and replaces what is yours:

```yaml
# kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes?ref=v1.2.3 # or a checkout's path
# components:
#   - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/redis?ref=v1.2.3

# The release, for every image: the sandboxes' too, below.
images:
  - { name: ghcr.io/bryansmee/deckhand-edge, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-orchestrator, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-runner, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-broker, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-github, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-models, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-policy, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-egress, newTag: v1.2.3 }

configMapGenerator:
  # The settings the orchestrator, the runner and the models service share: SANDBOX_IMAGE at
  # the same release (a reference the nodes can pull), and any other environment setting.
  - name: deckhand-env
    namespace: deckhand
    behavior: merge
    literals:
      - SANDBOX_IMAGE=ghcr.io/bryansmee/deckhand-sandbox:v1.2.3
  # Your config.yaml and grants folder (server.example/ to start from), one key per file.
  - name: deckhand-server
    namespace: deckhand
    behavior: replace
    files:
      - server/config.yaml
      - server/grants/default.yaml
      - acme-api.yaml=server/grants/acme/api.yaml
      - grants.rego=server/grants/policy/grants.rego

# Where each key goes under /etc/deckhand, in every service that reads the grants (the
# orchestrator, the runner, the github and policy services: they must read the same files).
patches:
  - target: { kind: Deployment, name: orchestrator|runner|github|policy }
    patch: |
      apiVersion: apps/v1
      kind: Deployment
      metadata: { name: any }
      spec:
        template:
          spec:
            volumes:
              - name: server
                projected:
                  sources:
                    - configMap:
                        name: deckhand-server
                        items:
                          - { key: config.yaml, path: config.yaml }
                          - { key: default.yaml, path: grants/default.yaml }
                          - { key: acme-api.yaml, path: grants/acme/api.yaml }
                          - { key: grants.rego, path: grants/policy/grants.rego }
  # The API server's addresses, the runner's and the broker's only way out (step 2).
  - target: { kind: NetworkPolicy, name: deckhand-api-server }
    patch: |
      - op: replace
        path: /spec/egress/0/to
        value:
          - ipBlock: { cidr: 172.18.0.2/32 }
```

`config.yaml`'s `allowed_users` is required, as with Compose: edge and the orchestrator don't
start without it. `config.yaml` is read at start: the pods restart when it changes, as the
ConfigMap's name carries a hash of it: so do the grants, which the services otherwise read
again at each run. Every service that mounts it restarts on an edit of either, the broker too
(for `metrics_port` alone).

## 2. The API server's addresses

The runner and the broker reach the API server alone, through the `deckhand-api-server`
NetworkPolicy, whose address in the base is a placeholder: your overlay names yours, one `ipBlock`
each (the last patch above).
[The API server's addresses](../kubernetes.md#the-api-servers-addresses) says how to find them.

## 3. Apply it

Then `kubectl apply -k .` creates both namespaces, the services, their claims, Roles and
NetworkPolicies. The pods wait for their Secrets: [finish the install](finish.md) with them, the
GitHub App and the isolation's check.
