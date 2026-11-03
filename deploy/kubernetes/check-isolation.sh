#!/bin/sh
# Whether the cluster enforces the sandboxes' NetworkPolicies (docs/kubernetes.md): a network
# plugin that doesn't (Flannel alone, say) takes them and isolates nothing. From a pod labelled
# as a sandbox, in the sandboxes' namespace, every port of every service's pod must be out of
# reach (their metrics port, 9464, the monitoring namespace's alone, included), and the egress proxy's port the only one reached (its engines' port, 3129, too when its
# Service publishes it: the engine component); the internet too stays out of reach.
#
#   sh deploy/kubernetes/check-isolation.sh [services' namespace] [sandboxes' namespace]
#
# It needs kubectl, with the right to create and exec into a pod of the sandboxes' namespace and
# to exec into the services' pods, and runs the egress proxy's image (node, already on your
# nodes). Exit code 0: isolated.
set -eu

services=${1:-deckhand}
sandboxes=${2:-deckhand-sandboxes}
pod=deckhand-isolation-check
image=$(kubectl -n "$services" get deployment egress -o jsonpath='{.spec.template.spec.containers[0].image}')
proxy=$(kubectl -n "$services" get service egress -o jsonpath='{.spec.clusterIP}')
# The engines' port, when the proxy's Service publishes it (components/engine): the sandboxes
# reach it too, their engines sharing their address.
engines=$(kubectl -n "$services" get service egress -o jsonpath='{.spec.ports[?(@.port==3129)].port}')

# Every port of every pod in the services' namespace, as pod@ip:port.
targets=$(kubectl -n "$services" get pods --field-selector=status.phase=Running -o \
  go-template='{{range .items}}{{$pod := .metadata.name}}{{$ip := .status.podIP}}{{range .spec.containers}}{{range .ports}}{{$pod}}@{{$ip}}:{{.containerPort}} {{end}}{{end}}{{end}}')
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

# Each address, within 3 s: "reached", "refused" or "out of reach" (no answer, or unreachable).
# A refusal is either a policy rejecting the connection (some plugins answer so) or a port
# nothing listens on, which proves nothing: told apart below.
TRY='
const net = require("node:net");
const tries = process.argv.slice(1).map((target) => new Promise((resolve) => {
  const [host, port] = target.split(/:(?=\d+$)/);
  const socket = net.connect({ host, port: Number(port), timeout: 3000 });
  const done = (result) => { socket.destroy(); resolve(`${target} ${result}`); };
  socket.on("connect", () => done("reached"));
  socket.on("timeout", () => done("out-of-reach"));
  socket.on("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : "out-of-reach"));
}));
Promise.all(tries).then((lines) => console.log(lines.join("\n")));
'

# Whether pod $1 listens on port $2, asked from inside it (its loopback, which no policy sees):
# "yes", "no", or "unknown" when its image has neither node nor nc. Its stdin is /dev/null: the
# loop below reads its targets from stdin, which a kubectl that forwards it (a `docker exec -i`
# wrapper, as deploy/kubernetes-e2e's) would take, leaving the rest unchecked.
listens() {
  if kubectl -n "$services" exec "$1" -- node -e "$TRY" "127.0.0.1:$2" </dev/null 2>/dev/null >/tmp/deckhand-listens.$$; then
    case "$(cat /tmp/deckhand-listens.$$)" in *reached) echo yes ;; *) echo no ;; esac
  elif kubectl -n "$services" exec "$1" -- nc -z -w 3 127.0.0.1 "$2" </dev/null >/dev/null 2>&1; then
    echo yes
  else
    echo unknown
  fi
  rm -f /tmp/deckhand-listens.$$
}

addresses=$(for t in $targets; do printf '%s ' "${t#*@}"; done)
results=$(kubectl -n "$sandboxes" exec "$pod" -- node -e "$TRY" "$proxy:3128" ${engines:+"$proxy:3129"} 1.1.1.1:443 $addresses)

failed=0
check() { # target, result, expected
  if [ "$2" = "$3" ]; then echo "ok    $1 $2"; else echo "FAIL  $1 $2 (expected: $3)"; failed=1; fi
}
while read -r address result; do
  owner=""
  for t in $targets; do [ "${t#*@}" = "$address" ] && owner=${t%@*}; done
  case "$address" in
    # The proxy, by its Service's address (the sandboxes' hostAliases) and its pods'.
    *:3128)
      check "$address" "$result" reached
      continue
      ;;
    # Its engines' port, published: the proxy's alone, any other pod's on 3129 still checked below.
    *:3129)
      if [ -n "$engines" ] && { [ "$address" = "$proxy:3129" ] || [ "${owner#egress-}" != "$owner" ]; }; then
        check "$address" "$result" reached
        continue
      fi
      ;;
  esac
  if [ "$result" = refused ] && [ -n "$owner" ]; then
    case "$(listens "$owner" "${address##*:}")" in
      yes) result=out-of-reach ;; # it listens: a policy refused the sandbox
      no)
        echo "ok    $address not listening ($owner): not checked"
        continue
        ;;
      *)
        # Fail closed: an unchecked port could be one the plugin lets through.
        echo "FAIL  $address refused, and $owner has neither node nor nc to say whether it listens: check it by hand"
        failed=1
        continue
        ;;
    esac
  elif [ "$result" = refused ]; then
    result=out-of-reach # the internet's address, which listens: a policy refused it
  fi
  check "$address" "$result" out-of-reach
done <<EOF
$results
EOF

if [ "$failed" = 1 ]; then
  echo "The sandboxes are NOT isolated: does your network plugin enforce NetworkPolicies?" >&2
  exit 1
fi
echo "Isolated: a sandbox reaches the egress proxy alone."
