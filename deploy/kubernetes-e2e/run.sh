#!/bin/bash
# Deckhand's end-to-end check on a cluster (#391): the base (../kubernetes) deployed with this
# checkout's images, GitHub and Anthropic replaced by fakes (fakes.mjs), then one run:
#
#   1. check-isolation.sh passes: a pod labelled as a sandbox reaches the egress proxy alone;
#   2. a comment on an issue (a signed webhook to edge) starts a sandbox pod, whose agent (Claude
#      Code, installed at its pinned version) talks to the fake model through the models service;
#   3. while it runs, a second comment is sent, and every service is restarted (`kubectl rollout
#      restart`, one copy at a time as their updates go): the fake model keeps the agent at work,
#      a 20 s command a turn, until the last rollout is done;
#   4. the run's reply is posted once, and says the second comment reached the agent;
#   5. none of the run's calls failed: each turn's command calls GitHub through the egress proxy
#      every 2 s (git, and gh through the GitHub gateway), and the fake model notes a command that failed
#      or a call made again (Claude Code retries a failed one by itself); the run's log has no
#      retry or connection error;
#   6. no sandbox pod is left.
#
#   K3S=k3s deploy/kubernetes-e2e/run.sh    # in a k3s container on Docker, started if missing
#   deploy/kubernetes-e2e/run.sh            # on the cluster kubectl points at: one to throw away
#
# It installs Deckhand in the namespaces deckhand, deckhand-sandboxes and deckhand-e2e, with the
# base's ClusterRoleBinding deckhand-broker-auth-delegator, all labelled deckhand.e2e=true, and
# refuses to start when one of them exists without that label (a real install's would be
# overwritten, its Secrets used, and then deleted) or the cluster can't say whether it does. They are
# deleted when it ends, whatever its outcome, and left for a look with KEEP=1; a later run deletes
# what an earlier one left before it starts.
#
# The images are built with `docker build` from this checkout (tag e2e) and, with K3S, loaded
# into its containerd; on another cluster, load them on its nodes yourself (SKIP_BUILD=1 to
# skip the build). It needs docker, node (secrets.mjs), openssl (the fakes' certificate) and,
# without K3S, kubectl. Claude Code goes into the agent's claim beforehand with K3S (or
# PREINSTALL_AGENT=1); without it, the runs install it, from the npm registry through the egress
# proxy. Exit code 0: every check passed.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
K3S=${K3S:-}
K3S_IMAGE=${K3S_IMAGE:-rancher/k3s:v1.33.5-k3s1}
MARKER="MIDRUN-$RANDOM$RANDOM"
SECRET=e2e-webhook-secret
NAMESPACES=(deckhand deckhand-sandboxes deckhand-e2e)
# The base's one cluster-scoped object (rbac.yaml): the broker's TokenReview binding.
BINDING=deckhand-broker-auth-delegator
work=$(mktemp -d)
ours= # set once the namespaces are this check's: the only ones the end deletes
# This check's namespaces deleted, their pods at once: a draining copy's grace period (660 s for
# models and the egress proxy) would hold the deletion. The Deployments first, which would start
# pods again in place of those removed.
delete_namespaces() {
  local ns
  for ns in "${NAMESPACES[@]}"; do
    kubectl -n "$ns" delete deployments --all --wait=false >/dev/null 2>&1 || true
    kubectl -n "$ns" delete pods --all --force --grace-period=0 >/dev/null 2>&1 || true
  done
  kubectl delete namespace "${NAMESPACES[@]}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete clusterrolebinding -l deckhand.e2e=true --ignore-not-found >/dev/null 2>&1 || true
}
finish() {
  if [ -n "$ours" ] && [ -z "${KEEP:-}" ]; then delete_namespaces; fi
  rm -rf "$work"
}
trap finish EXIT

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAILED: $*" >&2
  if [ -n "$ours" ] && [ -z "${KEEP:-}" ]; then
    echo "(KEEP=1 leaves the namespaces for a look)" >&2
  fi
  exit 1
}

# kubectl, in the k3s container with K3S: a shim on the PATH, which check-isolation.sh uses too.
if [ -n "$K3S" ]; then
  mkdir "$work/bin"
  printf '#!/bin/sh\nexec docker exec -i %s kubectl "$@"\n' "$K3S" >"$work/bin/kubectl"
  chmod +x "$work/bin/kubectl"
  PATH="$work/bin:$PATH"
fi

# Waits up to $1 seconds for `$2` (a command) to succeed.
wait_for() {
  local until=$((SECONDS + $1))
  shift
  until "$@"; do
    [ $SECONDS -lt $until ] || return 1
    sleep 3
  done
}
if [ -n "$K3S" ] && ! docker inspect "$K3S" >/dev/null 2>&1; then
  step "Starting k3s ($K3S_IMAGE) in a container named $K3S"
  # The cluster's own addresses never go through a proxy the Docker CLI may pass on (its
  # config.json's `proxies`): the API server reaches the kubelet directly.
  no_proxy=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local
  # k3s's own iptables (--prefer-bundled-bin), in legacy mode: its NetworkPolicy controller's
  # rules fail with nftables in a container ("Message too large"), and nothing is enforced.
  docker run -d --name "$K3S" --privileged --cgroupns=host \
    -e NO_PROXY="$no_proxy" -e no_proxy="$no_proxy" -e IPTABLES_MODE=legacy \
    "$K3S_IMAGE" server --disable traefik --disable metrics-server --prefer-bundled-bin >/dev/null
  until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 2; done
fi

step "Checking that the namespaces are this check's"
# Only what isn't there passes, or carries the label: an error asking (a timeout, Forbidden) fails
# the check rather than reading as absent, and nothing is deleted.
for object in "${NAMESPACES[@]/#/namespace/}" "clusterrolebinding/$BINDING"; do
  found=$(kubectl get "$object" --ignore-not-found \
    -o jsonpath='{.metadata.name}={.metadata.labels.deckhand\.e2e}') ||
    fail "couldn't ask the cluster for $object: nothing touched"
  [ -z "$found" ] || [ "$found" = "${object#*/}=true" ] ||
    fail "$object exists without the label deckhand.e2e=true: not a cluster for this check (kubectl config current-context: $(kubectl config current-context 2>/dev/null))"
done
ours=1
# What an earlier run left (KEEP=1, or still Terminating): its fakes' and stores' state would
# answer this run's checks.
gone_ns() {
  local names
  delete_namespaces
  names=$(kubectl get namespaces -o name) || return 1
  ! grep -qxE "namespace/($(IFS='|'; echo "${NAMESPACES[*]}"))" <<<"$names"
}
wait_for 300 gone_ns || fail "an earlier run's namespaces are still being deleted"
for ns in "${NAMESPACES[@]}"; do
  kubectl create namespace "$ns" --save-config >/dev/null
  kubectl label namespace "$ns" deckhand.e2e=true >/dev/null
done

images=(deckhand-e2e-fakes:e2e)
if [ -z "${SKIP_BUILD:-}" ]; then
  step "Building the images"
  build() { docker build -q -t "$1" -f "$root/$2" "$root" >/dev/null && echo "$1"; }
  build deckhand-e2e-fakes:e2e deploy/kubernetes-e2e/Dockerfile
  for pair in edge orchestrator runner broker github models policy:policy-service egress:proxy sandbox; do
    name=${pair%%:*}
    build "ghcr.io/bryansmee/deckhand-$name:e2e" "${pair#*:}/Dockerfile"
  done
fi
for name in edge orchestrator runner broker github models policy egress sandbox; do
  images+=("ghcr.io/bryansmee/deckhand-$name:e2e")
done
if [ -n "$K3S" ] && [ -z "${SKIP_BUILD:-}" ]; then
  step "Loading them into $K3S"
  docker save "${images[@]}" | docker exec -i "$K3S" ctr -n k8s.io images import - >/dev/null
fi

step "Deploying the base with the fakes"
# The overlay's files where kubectl reads them: in the container with K3S.
if [ -n "$K3S" ]; then
  tar -C "$root" -c deploy/kubernetes deploy/kubernetes-e2e |
    docker exec -i "$K3S" sh -c 'rm -rf /deckhand-e2e && mkdir /deckhand-e2e && tar x -C /deckhand-e2e'
  overlay=/deckhand-e2e/deploy/kubernetes-e2e
else
  overlay=$root/deploy/kubernetes-e2e
fi
# The fakes' certificate, from a CA of this run's that the services trust (the overlay's
# NODE_EXTRA_CA_CERTS): the egress proxy relays GitHub's host over HTTPS only. Made before the
# pods that mount them.
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=deckhand-e2e-ca \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=fakes -keyout "$work/tls.key" \
  -out "$work/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:github.deckhand-e2e.svc.cluster.local,DNS:anthropic.deckhand-e2e.svc.cluster.local\n' \
  >"$work/san"
openssl x509 -req -in "$work/tls.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" \
  -CAcreateserial -days 7 -extfile "$work/san" -out "$work/tls.crt" 2>/dev/null
# As YAML on stdin: with K3S, kubectl runs in the container, which has none of $work's files.
b64() { base64 <"$work/$1" | tr -d '\n'; }
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Secret
type: kubernetes.io/tls
metadata: { name: fakes-tls, namespace: deckhand-e2e }
data: { tls.crt: $(b64 tls.crt), tls.key: $(b64 tls.key) }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: e2e-ca, namespace: deckhand }
binaryData: { ca.crt: $(b64 ca.crt) }
YAML
kubectl apply -k "$overlay" >/dev/null
# The API server's addresses, every one (a control plane may have several), the runner's and the
# broker's way out (docs/kubernetes.md, step 2).
to=$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}' |
  node -e 'let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
    const ips = [...new Set(t.split(/\s+/).filter(Boolean))];
    if (!ips.length) process.exit(1);
    console.log(JSON.stringify(ips.map((ip) => ({ ipBlock: { cidr: ip.includes(":") ? `${ip}/128` : `${ip}/32` } }))));
  });') || fail "no address for the API server"
kubectl -n deckhand patch networkpolicy deckhand-api-server --type json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/egress/0/to\",\"value\":$to}]" >/dev/null
# The Secrets (step 3 and 4), this check's own, the App's made up: the fake GitHub takes any key.
node "$root/deploy/kubernetes/secrets.mjs" keys | kubectl apply -f - >/dev/null
kubectl -n deckhand create secret generic deckhand-models \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-e2e >/dev/null
(cd "$root" && SECRET=$SECRET node --input-type=module -e '
  import { generateKeyPairSync } from "node:crypto";
  import { appSecrets } from "./deploy/kubernetes/secrets.mjs";
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" });
  const app = {
    id: 1, slug: "deckhand-e2e", client_id: "Iv1.e2e", client_secret: "e2e",
    webhook_secret: process.env.SECRET, pem, owner: { login: "org" },
    html_url: "https://github.deckhand-e2e.svc.cluster.local/apps/deckhand-e2e",
  };
  const publicUrl = "http://edge.deckhand.svc.cluster.local:8080";
  process.stdout.write(appSecrets(app, { publicUrl, namespace: "deckhand" }));
') | kubectl apply -f - >/dev/null
for ns in deckhand deckhand-e2e; do
  kubectl -n "$ns" wait --for=condition=Available deployment --all --timeout=300s >/dev/null
done
kubectl -n deckhand get pods

# Claude Code, installed with the sandbox image on Docker and copied into the agent's claim
# (docs/kubernetes.md, Agents on Kubernetes: a claim filled beforehand), for a cluster whose pods
# can't reach npm's registry (PREINSTALL_AGENT=1, the default with K3S: a cluster in Docker
# may have no way out but its host's proxy). Runs install nothing then.
if [ "${PREINSTALL_AGENT:-${K3S:+1}}" = 1 ]; then
  step "Installing Claude Code into its claim"
  version=$(sed -n 's/^ *CLAUDE_CODE_VERSION: { default: "\(.*\)" },$/\1/p' "$root/listener/config.mjs")
  kubectl apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: deckhand-claude-code, namespace: deckhand-sandboxes }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
---
apiVersion: v1
kind: Pod
metadata: { name: deckhand-e2e-agent-fill, namespace: deckhand-sandboxes }
spec:
  automountServiceAccountToken: false
  securityContext:
    { runAsNonRoot: true, runAsUser: 1001, fsGroup: 1001, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: fill
      image: ghcr.io/bryansmee/deckhand-sandbox:e2e
      command: [sleep, "3600"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumeMounts: [{ name: claim, mountPath: /claim }]
  volumes: [{ name: claim, persistentVolumeClaim: { claimName: deckhand-claude-code } }]
YAML
  kubectl -n deckhand-sandboxes wait --for=condition=Ready pod/deckhand-e2e-agent-fill \
    --timeout=300s >/dev/null
  docker run --rm -u 0 -e CLAUDE_CODE_VERSION="$version" --entrypoint bash \
    ghcr.io/bryansmee/deckhand-sandbox:e2e -c \
    "deckhand-install-claude-code >&2 && tar -C /opt/claude-code -c '$version'" |
    kubectl -n deckhand-sandboxes exec -i deckhand-e2e-agent-fill -- \
      tar x --no-same-owner -C /claim
  kubectl -n deckhand-sandboxes delete pod deckhand-e2e-agent-fill --wait=false >/dev/null
  echo "Claude Code $version in the claim deckhand-claude-code"
fi

step "Checking the isolation (check-isolation.sh)"
# The network plugin applies the policies within seconds of the pods' start: tried again until then.
wait_for 120 sh "$root/deploy/kubernetes/check-isolation.sh" || fail "the sandboxes aren't isolated"

# What a fake was asked (fakes.mjs /__requests), as JSON.
asked() {
  kubectl -n deckhand-e2e exec "deploy/$1" -- node -e \
    'fetch("http://127.0.0.1:8080/__requests").then((r) => r.text()).then((t) => process.stdout.write(t))'
}
# A comment by alice on org/repo#12, signed as GitHub signs it, delivered to edge from the fakes'
# namespace (edge's port 8080 is open to any pod: it is what the ingress reaches).
comment() {
  kubectl -n deckhand-e2e exec -i deploy/github -- node -e '
    const { createHmac, randomUUID } = require("node:crypto");
    const [secret, id, text] = process.argv.slice(1);
    const body = JSON.stringify({
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "main", private: false, owner: { login: "org" } },
      issue: { number: 12, title: "End-to-end check", user: { login: "alice" }, labels: [], state: "open" },
      comment: { id: Number(id), body: text, user: { login: "alice", type: "User" }, author_association: "OWNER" },
      sender: { login: "alice", type: "User" },
    });
    fetch("http://edge.deckhand.svc.cluster.local:8080/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    }).then((r) => { console.log(`edge answered ${r.status}`); process.exit(r.status === 202 ? 0 : 1); });
  ' "$SECRET" "$1" "$2"
}
# The runs' pods: a sandbox's labels, without the network probe's and check-isolation.sh's.
sandbox_pods() {
  kubectl -n deckhand-sandboxes get pods -l 'deckhand.role=sandbox,deckhand.run,deckhand.run!=network-probe' \
    -o name 2>/dev/null
}
started() { [ -n "$(sandbox_pods)" ]; }
gone() { [ -z "$(sandbox_pods)" ]; }
# The model's first turn: its command that waits (fakes.mjs).
waiting() { asked anthropic | node -e '
  let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () =>
    process.exit(JSON.parse(t).some((r) => r.body?.includes("\"Bash\"")) ? 0 : 1));'; }
# The run's reply naming the marker, in a comment Deckhand posted or edited.
replied() { asked github | MARKER=$MARKER node -e '
  let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
    const writes = JSON.parse(t).filter((r) => /^(POST|PATCH)$/.test(r.method) && /\/comments/.test(r.path));
    process.exit(writes.some((r) => r.body.includes(process.env.MARKER)) ? 0 : 1);
  });'; }

step "A comment starts a run"
comment 101 $'Deckhand\n\nPlease check that a comment sent mid-run reaches you.'
wait_for 300 started || fail "no sandbox pod started"
sandbox_pods
wait_for 600 waiting || fail "the agent never called the model with its tools"
echo "The agent's first command runs: a comment, then every service restarted"

step "A comment mid-run, and every service updated"
comment 102 "Here is a comment sent mid-run: $MARKER"
kubectl -n deckhand rollout restart deployment >/dev/null
for deployment in $(kubectl -n deckhand get deployments -o name); do
  kubectl -n deckhand rollout status "$deployment" --timeout=900s >/dev/null
  echo "$deployment updated"
done
started || fail "the run ended before the update was done"
# The model may finish: its next turn answers.
kubectl -n deckhand-e2e exec deploy/anthropic -- node -e \
  'fetch("http://127.0.0.1:8080/__release", { method: "POST" }).then((r) => process.exit(r.ok ? 0 : 1))'

step "The reply"
wait_for 900 replied || fail "no reply naming $MARKER"
asked github | MARKER=$MARKER node -e '
  let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
    const requests = JSON.parse(t);
    const posts = requests.filter((r) => r.method === "POST" && /\/issues\/12\/comments$/.test(r.path));
    const writes = requests.filter((r) => /^(POST|PATCH)$/.test(r.method) && /\/comments(\/\d+)?$/.test(r.path));
    for (const r of writes) console.log(`${r.method} ${r.path}: ${JSON.parse(r.body).body.split("\n")[0].slice(0, 140)}`);
    const final = posts.filter((r) => r.body.includes(process.env.MARKER));
    if (final.length !== 1) { console.error(`the reply was posted ${final.length} times`); process.exit(1); }
  });'

step "No call failed"
# The fake model's view: a turn's command that failed, a call made again, and the turns whose
# calls all answered (the first ran as the update started, the last as it ended).
seen=$(kubectl -n deckhand-e2e exec deploy/anthropic -- node -e \
  'fetch("http://127.0.0.1:8080/__problems").then((r) => r.text()).then((t) => process.stdout.write(t))')
problems=$(node -e 'JSON.parse(process.argv[1]).problems.forEach((p) => console.log(p))' "$seen")
[ -z "$problems" ] || fail "what the model saw go wrong: $problems"
turns=$(node -e 'console.log(JSON.parse(process.argv[1]).turns)' "$seen")
[ "$turns" -ge 1 ] || fail "no turn's calls to GitHub all answered"
# The run's log, in the runner's store (the file backend, on its claim; no BLOB_URL, so no
# segment moved out): Claude Code's retries
# (api_retry), and what git, curl or Node say of a call that failed.
run_log=$(kubectl -n deckhand exec deploy/runner -- sh -c 'cat /data/store/blobs/logs*') ||
  fail "no run log in the runner's store"
[ -n "$run_log" ] || fail "an empty run log in the runner's store"
errors=$(grep -E '"subtype":"api_retry"|fatal:|ECONNRESET|ECONNREFUSED|socket hang up|returned error|couldn.t be renewed|curl: \([0-9]+\)|HTTP 5[0-9]{2}' <<<"$run_log" | cut -c1-300 || true)
[ -z "$errors" ] || fail "the run's log has errors: $errors"
echo "No failed or repeated call; $turns turns called GitHub 10 times each, through the update"
wait_for 300 gone || fail "a sandbox pod was left: $(sandbox_pods)"
echo "No sandbox pod left"

step "Passed"
