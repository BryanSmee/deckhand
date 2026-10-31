#!/bin/bash
# server.test.mjs's opa: Deckhand's default policies (policy/*.rego) apply in every listener, and
# a machine without opa would refuse each write (fail closed). This one compiles them, allows
# everything and denies nothing; the real one evaluates them in github-writes.test.mjs.
case "$1" in
  capabilities) echo '{"builtins":[]}' ;;
  check) exit 0 ;;
  eval) echo '{"result":[{"expressions":[{"value":{"operator":{"allow":[true],"deny":[[]]},"repo":{"allow":[true],"deny":[[]]}}}]}]}' ;;
  *) exit 2 ;;
esac
