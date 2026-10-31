#!/bin/bash
# server.test.mjs's opa for a refusal: compiles every policy, and every decision's deny rule
# says "not today" (deny_run's wiring test).
case "$1" in
  capabilities) echo '{"builtins":[]}' ;;
  check) exit 0 ;;
  eval) echo '{"result":[{"expressions":[{"value":{"operator":{"allow":[true],"deny":[["not today"]]},"repo":{"allow":[true],"deny":[["not today"]]}}}]}]}' ;;
  *) exit 2 ;;
esac
