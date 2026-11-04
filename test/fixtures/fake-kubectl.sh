#!/bin/bash
# check-isolation.test.mjs's kubectl, linked into each test's temp dir (on the script's PATH): it
# plays a cluster from files in that dir.
#   targets   the services' pods' ports, as `get pods`'s go-template prints them (pod@ip:port …)
#   engines   present: the egress proxy's Service publishes 3129 (the engine component)
#   reach     what a sandbox gets, one `address result` a line (reached, refused, out-of-reach);
#             any other address is out of reach
#   listens   what a service's pod says of its own port, one `pod port tool answer` a line: tool
#             node, nc or none (neither in its image), answer yes or no; not listed: no
# Every `exec` reads its stdin to the end, as a `docker exec -i` wrapper's would (#728): a call
# the script doesn't give /dev/null eats what its caller's loop had left to read. Each call is
# logged in kubectl-calls, one a line.
dir=${0%/*}
echo "$*" >>"$dir/kubectl-calls"
[ "$1" = -n ] && shift 2
case "$1 $2 $3" in
  "get deployment egress") echo registry.example/deckhand-proxy:test ;;
  "get service egress")
    case "$*" in
      *clusterIP*) echo 10.43.0.10 ;;
      *3129*) if [ -f "$dir/engines" ]; then echo 3129; fi ;;
    esac
    ;;
  "get pods "*) if [ -f "$dir/targets" ]; then cat "$dir/targets"; fi ;;
  "get pod deckhand-isolation-peer") echo 10.42.0.99 ;;
  "apply -f -") cat >"$dir/applied" ;;
  "wait "* | "delete "*) cat >/dev/null ;;
  "exec "*)
    cat >/dev/null
    pod=$2
    shift 3 # exec, the pod, --
    tool=$1
    if [ "$pod" = deckhand-isolation-check ]; then
      shift 3 # node -e TRY
      for target in "$@"; do
        result=out-of-reach
        [ -f "$dir/reach" ] && while read -r address answer; do
          [ "$address" = "$target" ] && result=$answer
        done <"$dir/reach"
        echo "$target $result"
      done
      exit
    fi
    # A service's pod, asked whether it listens: node -e TRY 127.0.0.1:port, or nc -z -w 3
    # 127.0.0.1 port.
    if [ "$tool" = node ]; then port=${4##*:}; else port=${!#}; fi
    has=none answer=no
    if [ -f "$dir/listens" ]; then
      while read -r p q t a; do
        [ "$p" = "$pod" ] && [ "$q" = "$port" ] && has=$t answer=$a
      done <"$dir/listens"
    fi
    # Not listed: node in its image, and nothing listening.
    grep -q "^$pod $port " "$dir/listens" 2>/dev/null || has=node
    [ "$has" = "$tool" ] || exit 126
    if [ "$tool" = node ]; then
      [ "$answer" = yes ] && echo "127.0.0.1:$port reached" || echo "127.0.0.1:$port refused"
    else
      [ "$answer" = yes ]
    fi
    ;;
  *)
    echo "fake kubectl: unexpected call: $*" >&2
    exit 1
    ;;
esac
