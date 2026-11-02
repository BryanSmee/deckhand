#!/bin/sh
# Whether the cluster enforces the sandboxes' NetworkPolicies (docs/kubernetes.md): a network
# plugin that doesn't (Flannel alone, say) takes them and isolates nothing. From a pod labelled
# as a sandbox, in the sandboxes' namespace, every port of every service's pod must be out of
# reach, and the egress proxy's port the only one reached; the internet too stays out of reach.
#
#   sh deploy/kubernetes/check-isolation.sh [services' namespace] [sandboxes' namespace]
#
# It needs kubectl, with the right to create and exec into a pod of the sandboxes' namespace,
# and runs the egress proxy's image (node, already on your nodes). Exit code 0: isolated.
set -eu

services=${1:-deckhand}
sandboxes=${2:-deckhand-sandboxes}
pod=deckhand-isolation-check
image=$(kubectl -n "$services" get deployment egress -o jsonpath='{.spec.template.spec.containers[0].image}')
proxy=$(kubectl -n "$services" get service egress -o jsonpath='{.spec.clusterIP}')

# Every port of every pod in the services' namespace, as ip:port.
targets=$(kubectl -n "$services" get pods --field-selector=status.phase=Running -o \
  go-template='{{range .items}}{{$ip := .status.podIP}}{{range .spec.containers}}{{range .ports}}{{$ip}}:{{.containerPort}} {{end}}{{end}}{{end}}')
[ -n "$targets" ] || { echo "No running pod with a port in $services: is Deckhand deployed?" >&2; exit 1; }

cleanup() { kubectl -n "$sandboxes" delete pod "$pod" --ignore-not-found --wait=false >/dev/null; }
trap cleanup EXIT

# A sandbox's labels and Pod Security `restricted`, as the runner's pods have them.
kubectl -n "$sandboxes" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    deckhand.role: sandbox
spec:
  automountServiceAccountToken: false
  enableServiceLinks: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: check
      image: $image
      command: [sleep, "300"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
EOF
kubectl -n "$sandboxes" wait --for=condition=Ready "pod/$pod" --timeout=120s >/dev/null

# Each address: "reached" or "out of reach", within 3 s.
kubectl -n "$sandboxes" exec "$pod" -- node -e '
const net = require("node:net");
const tries = process.argv.slice(1).map((target) => new Promise((resolve) => {
  const [host, port] = target.split(/:(?=\d+$)/);
  const socket = net.connect({ host, port: Number(port), timeout: 3000 });
  const done = (reached) => { socket.destroy(); resolve(`${target} ${reached ? "reached" : "out of reach"}`); };
  socket.on("connect", () => done(true));
  socket.on("timeout", () => done(false));
  socket.on("error", () => done(false));
}));
Promise.all(tries).then((lines) => console.log(lines.join("\n")));
' "$proxy:3128" 1.1.1.1:443 $targets | {
  failed=0
  while read -r target result extra; do
    result="$result${extra:+ $extra}"
    case "$target" in
      # The proxy, by its Service's address (the sandboxes' hostAliases) and its pods'.
      *:3128) want=reached ;;
      *) want="out of reach" ;;
    esac
    if [ "$result" = "$want" ]; then
      echo "ok    $target $result"
    else
      echo "FAIL  $target $result (expected: $want)"
      failed=1
    fi
  done
  if [ "$failed" = 1 ]; then
    echo "The sandboxes are NOT isolated: does your network plugin enforce NetworkPolicies?" >&2
    exit 1
  fi
  echo "Isolated: a sandbox reaches the egress proxy alone."
}
