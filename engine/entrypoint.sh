#!/bin/sh
# The container engine sidecar's entrypoint (../listener/runner/engine.mjs), for both images:
# the engine's only way out is the run's egress proxy (EGRESS_PROXY, set by the runner), by
# address rather than name, so the containers it starts reach it too: they can't resolve
# names on the run's network. Then the engine itself ("$@").
set -eu

if [ -n "${EGRESS_PROXY:-}" ]; then
  rest=${EGRESS_PROXY#*://}
  host=${rest%%[:/]*}
  port=${rest#"$host"}
  port=${port#:}
  port=${port%%/*}
  address=$(getent hosts "$host" | awk '{ print $1; exit }') || true
  proxy="http://${address:-$host}${port:+:$port}"
  export HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy"
  export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
fi

exec "$@"
