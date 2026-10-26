#!/bin/bash
# policies.test.mjs's opa for opaRunner(): `env` prints the environment it got, `echo` its
# arguments, working dir and stdin, `sleep` never ends on its own, `fail` exits 2 on stderr.
case "$1" in
  env) env ;;
  echo) printf '%s\n' "$*" "$PWD" && cat ;;
  sleep) exec sleep 30 ;;
  fail) echo "broken" >&2 && exit 2 ;;
esac
