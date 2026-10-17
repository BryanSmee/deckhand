#!/bin/bash
# server.test.mjs's docker, linked into each test's temp dir (on the listener's PATH): it plays
# Docker on files in that dir.
# Sandboxes run detached: `run` starts the fake sandbox in the background (its output in
# containers/<name>/out), `logs --follow` tails it, `ps`, `inspect`, `wait` and `rm` see it.
# Each run's network is a file in nets/, listing the containers joined to it: the sandbox,
# the listener (whatever its host name) and the egress proxy, `egress-1`, whose address is
# 127.0.0.1 (the fake sandbox asks the egress policy from there).
# The fake sandbox asks the broker and the egress policy, prints a result (once $dir/go
# exists, if $dir/hold does), then answers each comment of its inbox until the listener
# closes it. What a test checks is logged in docker-calls, one call per line.
# Builtins rather than dirname, cat, basename or grep on the paths called most: the tests
# make thousands of calls, and each process counts.
dir=${0%/*}
# The fake sandbox's script (below) reads it too.
export dir
c="$dir/containers"
alive() { [ -f "$c/$1/pid" ] && read -r pid < "$c/$1/pid" && kill -0 "$pid" 2> /dev/null; }
# A pause without a sleep process: a read that times out on a pipe nothing writes to.
nap() { [ -n "${never-}" ] || exec {never}<> <(:); read -r -t 0.05 -u "$never" _ || :; }
# Whether the file $2 has the line $1.
listed() { local line; while IFS= read -r line; do [ "$line" = "$1" ] && return; done < "$2"; false; }
case "$1" in
  ps)
    case "$*" in *deckhand.role=egress*) echo egress-1; exit ;; esac
    for d in "$c"/*/; do
      [ -d "$d" ] || continue
      n=${d%/}
      n=${n##*/}
      alive "$n" && state=running || state=exited
      read -r run < "$d/run"
      printf '%s\t%s\t%s\n' "$n" "$run" "$state"
    done ;;
  wait)
    while alive "${@: -1}"; do nap; done ;;
  stop)
    # A cancelled run's sandbox; one the test says is stuck ignores it.
    echo "$*" >> "$dir/docker-calls"
    n=${@: -1}
    [ -d "$c/$n" ] || exit 1
    [ -e "$dir/stuck" ] && exit 0
    read -r pid < "$c/$n/pid"
    kill -TERM -- -"$pid" 2> /dev/null
    while alive "$n"; do nap; done ;;
  rm)
    n=${@: -1}
    [ -f "$c/$n/run" ] && sed -i "/^$n\$/d" "$dir/nets/$(cat "$c/$n/run")" 2> /dev/null
    rm -rf "$c/$n" ;;
  logs)
    n=${@: -1}
    [ -d "$c/$n" ] || exit 1
    exec tail -n +1 -f --pid="$(cat "$c/$n/pid")" -s 0.05 "$c/$n/out" ;;
  network)
    n=${@: -1}
    net=${@: -2:1}
    case "$2" in
      create)
        echo "$*" >> "$dir/docker-calls"
        mkdir -p "$dir/nets" && : > "$dir/nets/$n" ;;
      inspect)
        [ -f "$dir/nets/$n" ] || exit 1
        case "$*" in
          *Containers*) tr '\n' ' ' < "$dir/nets/$n" ;;
          # Internal unless the test says otherwise.
          *) internal=true
            [ -f "$dir/network-internal" ] && read -r internal < "$dir/network-internal"
            echo "$internal" ;;
        esac ;;
      connect)
        echo "$*" >> "$dir/docker-calls"
        [ -f "$dir/nets/$net" ] || exit 1
        echo "$n" >> "$dir/nets/$net" ;;
      disconnect)
        sed -i "/^$n\$/d" "$dir/nets/$net" ;;
      rm)
        echo "$*" >> "$dir/docker-calls"
        rm -f "$dir/nets/$n" ;;
      ls)
        ls "$dir/nets" 2> /dev/null ;;
    esac ;;
  inspect)
    n=${@: -1}
    case "$3" in
      *State*)
        [ -d "$c/$n" ] || exit 1
        alive "$n" && echo running || echo exited ;;
      *compose.project*) echo deckhand ;;
      *deckhand.run*)
        [ -d "$c/$n" ] || exit 1
        cat "$c/$n/run" ;;
      # A sandbox's address on its network, for the egress proxy's questions; the listener's
      # and the proxy's on each network they are joined to.
      *)
        if [ -d "$c/$n" ]; then
          read -r run < "$c/$n/run"
          printf '{"%s":{"IPAddress":"10.9.0.5"}}\n' "$run"
          exit
        fi
        ip=10.9.0.1
        [ "$n" = egress-1 ] && ip=127.0.0.1
        printf '{"deckhand_default":{"IPAddress":"%s"}' "$ip"
        for f in "$dir"/nets/*; do
          [ -f "$f" ] && listed "$n" "$f" && printf ',"%s":{"IPAddress":"%s"}' "${f##*/}" "$ip"
        done
        echo "}" ;;
    esac ;;
  volume)
    # The volumes a test says exist (one name per line in $dir/volumes).
    if [ "$2" = inspect ]; then grep -qx -- "${@: -1}" "$dir/volumes" 2> /dev/null; exit; fi
    [ "$2" = ls ] && exit
    echo "$*" >> "$dir/docker-calls" ;;
  image)
    # Asked while the run is prepared, so a test can change things then.
    [ "$2" = inspect ] && [ -x "$dir/while-preparing" ] && "$dir/while-preparing"
    # The base image exists; repo images don't, until built.
    [ "$2" = inspect ] && case "$*" in *-repo-*) exit 1 ;; *) echo sha256:base ;; esac ;;
  create|cp|start)
    # A preview hook's container.
    echo "$*" >> "$dir/docker-calls" ;;
  build)
    echo "$*" >> "$dir/docker-calls"
    # The build context is the repo's checkout.
    cp "${@: -1}/docker/Dockerfile" "$dir/built-dockerfile" ;;
  info)
    echo '{"runc":{}}' ;;
  run)
    case "$*" in *--entrypoint*) echo "$*" >> "$dir/docker-calls"; exit 0 ;; esac
    # A run's container engine: its arguments, one per line, and nothing runs.
    case "$*" in *"--network-alias engine"*) printf '%s\n' "$@" > "$dir/engine-args"; exit 0 ;; esac
    # Its name and its run's id, from its arguments.
    for arg in "$@"; do
      [ "${prev-}" = --name ] && name=$arg
      case "$arg" in deckhand.run=*) run=${arg#deckhand.run=} ;; esac
      prev=$arg
    done
    mkdir -p "$c/$name"
    echo "$run" > "$c/$name/run"
    # On its run's network before run-args tells a test it started.
    echo "$name" >> "$dir/nets/$run"
    # Each file renamed into place, so a test never reads one half-written; run-args last:
    # tests wait for it, then read the others. (Not .tmp: tests look for leftover state writes.)
    echo "$DECKHAND_RUN_SECRET" > "$dir/run-secret.part" && mv "$dir/run-secret.part" "$dir/run-secret"
    env > "$dir/run-env.part" && mv "$dir/run-env.part" "$dir/run-env"
    printf '%s\n' "$@" > "$dir/run-args.part" && mv "$dir/run-args.part" "$dir/run-args"
    setsid bash -c '
      nap() { [ -n "${never-}" ] || exec {never}<> <(:); read -r -t 0.05 -u "$never" _ || :; }
      curl -fsS -H "Authorization: Bearer $DECKHAND_RUN_SECRET" "$DECKHAND_BROKER_URL/token" \
        > "$dir/broker-answer"
      # What the egress proxy would ask about this sandbox'"'"'s connections, "host answer"
      # lines: one curl for them all (the tests run many sandboxes, each process counts).
      hosts=(api.anthropic.com github.com objects.githubusercontent.com evil.example
        registry.npmjs.org pypi.org a.b.example.com example.com lan.internal)
      urls=()
      for host in "${hosts[@]}"; do urls+=("$DECKHAND_BROKER_URL/egress?ip=10.9.0.5&host=$host"); done
      i=0
      curl -sS -w "\n" "${urls[@]}" | while IFS= read -r answer; do
        echo "${hosts[i++]} $answer"
      done >> "$dir/egress"
      # Claude Code'"'"'s API call, through the listener, with the run'"'"'s secret.
      bearer="${ANTHROPIC_AUTH_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"
      if [ -n "$bearer" ]; then
        curl -sS -X POST -H "Authorization: Bearer $bearer" \
          -d "{}" "$ANTHROPIC_BASE_URL/v1/messages?beta=true" > "$dir/anthropic-answer"
      fi
      # Not all of stdout is Claude'"'"'s: gh prints the draft pull request'"'"'s address.
      echo "https://github.com/org/repo/pull/13"
      if [ -e "$dir/hold" ]; then
        until [ -e "$dir/go" ]; do nap; done
      fi
      # Each run'"'"'s agent, provider and session, and its first message (fallbacks).
      echo "$SANDBOX_AGENT@$SANDBOX_PROVIDER ${TASK_SESSION:-default}" >> "$dir/runs-seen"
      { echo "$TASK_MESSAGE"; echo ----; } >> "$dir/messages"
      { echo "$TASK_PROMPT"; echo ----; } >> "$dir/prompts"
      # A provider the test says fails: Claude Code'"'"'s API error. Or a task that fails.
      if grep -qx "$SANDBOX_AGENT@$SANDBOX_PROVIDER" "$dir/failing" 2> /dev/null; then
        echo "{\"type\":\"result\",\"is_error\":true,\"result\":\"API Error: 529 overloaded_error: Overloaded\",\"duration_ms\":1000}"
        exit 0
      fi
      if [ -e "$dir/task-fails" ]; then
        echo "{\"type\":\"result\",\"is_error\":true,\"result\":\"The tests still fail.\",\"duration_ms\":1000}"
        exit 0
      fi
      # Codex: its API call through the listener, one turn on the message it was given, and
      # no inbox to read (it takes no messages mid-run).
      if [ "$SANDBOX_AGENT" = codex ]; then
        curl -sS -X POST -H "Authorization: Bearer $OPENAI_API_KEY" \
          -d "{}" "$OPENAI_BASE_URL/responses" > "$dir/openai-answer"
        text="Codex did: ${TASK_MESSAGE:-the issue}"
        echo '"'"'{"type":"thread.started","thread_id":"t1"}'"'"'
        jq -nc --arg text "$text" '"'"'{type: "item.completed", item: {id: "item_0", type: "agent_message", text: $text}}'"'"'
        echo '"'"'{"type":"turn.completed","usage":{}}'"'"'
        jq -nc --arg text "$text" '"'"'{type: "deckhand.result", ok: true, text: $text, duration_ms: 60000}'"'"'
        exit 0
      fi
      # The Antigravity CLI: what the egress proxy would ask about its own hosts, a call to the
      # listener'"'"'s relay on a path it refuses (the real one would reach Google), and its
      # stream-json.
      if [ "$SANDBOX_AGENT" = antigravity ]; then
        if [ -n "${GEMINI_API_KEY:-}" ]; then
          curl -sS -X POST -H "x-goog-api-key: $GEMINI_API_KEY" \
            -d "{}" "$GOOGLE_GEMINI_BASE_URL/v1beta/models/$SANDBOX_MODEL:streamGenerateContent?alt=sse" \
            > "$dir/google-answer"
        fi
        for host in daily-cloudcode-pa.googleapis.com www.googleapis.com antigravity-unleash.goog \
          play.googleapis.com lh3.googleusercontent.com; do
          echo "$host $(curl -sS "$DECKHAND_BROKER_URL/egress?ip=10.9.0.5&host=$host")"
        done >> "$dir/egress-agy"
        curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $DECKHAND_RUN_SECRET" \
          "$DECKHAND_BROKER_URL/relay/www.googleapis.com/drive/v3/files" > "$dir/relay-answer"
        # Its model list refused (the test says so): agy only says the model is unknown.
        if [ -e "$dir/agy-no-models" ]; then
          curl -sS -o /dev/null -X POST -H "Authorization: Bearer $DECKHAND_RUN_SECRET" \
            "$DECKHAND_BROKER_URL/relay/daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
          echo '"'"'{"event":"result","result":{"status":"ERROR","error":"invalid model selection (--model \"gemini-4-argon-high\" --effort \"\"): model gemini-4-argon-high is not recognized"}}'"'"'
          exit 0
        fi
        echo '"'"'{"event":"init","conversation_id":"c1","init":{}}'"'"'
        jq -nc --arg text "agy did: ${TASK_MESSAGE:-the issue}" '"'"'{event: "result", result: {status: "SUCCESS", response: $text, duration_seconds: 60}}'"'"'
        exit 0
      fi
      result="All done."
      # A run talked into posting secrets: its own, and whatever the test leaves in leak.
      [ -e "$dir/leak" ] && result="Leaked $DECKHAND_RUN_SECRET and $(cat "$dir/leak")."
      echo "{\"type\":\"result\",\"result\":\"$result\",\"duration_ms\":60000}"
      # Its inbox, until the close line: what the image'"'"'s deckhand-inbox does (runner.test.mjs),
      # without a Node process per sandbox.
      close="{\"type\":\"deckhand\",\"event\":\"close\"}"
      while IFS= read -r line && [ "$line" != "$close" ]; do
        echo "$line" >> "$dir/delivered"
        if [ -e "$dir/hold-answer" ]; then
          until [ -e "$dir/answer" ]; do nap; done
        fi
        echo "{\"type\":\"result\",\"result\":\"Answered.\",\"duration_ms\":6000}"
      done < <(tail -n +1 -f --pid=$$ -s 0.05 "$dir/runs/$1/inbox.jsonl")
    ' sandbox "$run" > "$c/$name/out" 2> "$c/$name/err" < /dev/null &
    echo $! > "$c/$name/pid"
    ;;
esac
