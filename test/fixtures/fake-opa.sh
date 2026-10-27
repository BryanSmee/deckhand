#!/bin/bash
# policies.test.mjs's opa for opaRunner(): `env` prints the environment it got, `echo` its
# arguments, working dir and stdin, `sleep` never ends on its own, `fail` exits 2 on stderr.
# `capabilities` and `check` answer as the real one: `check` replays opa-check-errors.json,
# recorded from opa 1.21 on policy/net.rego and policy/size.rego (policies.test.mjs NET, SIZE).
case "$1" in
  env) env ;;
  echo) printf '%s\n' "$*" "$PWD" && cat ;;
  sleep) exec sleep 30 ;;
  fail) echo "broken" >&2 && exit 2 ;;
  capabilities) echo '{"builtins":[{"name":"count"}]}' ;;
  check) cat "$(dirname "$0")/opa-check-errors.json" >&2 && exit 1 ;;
esac
