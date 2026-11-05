# Codex, the sandbox's half of the agent seam (../../listener/agents/codex.mjs is the
# listener's). Sourced by entrypoint.sh, with the same functions as claude.sh (see there).
#
# Its home, CODEX_HOME, is the issue's session volume: config.toml (its provider, the
# listener, and the MCP servers) and hooks.json are written again on every start, so the
# volume never keeps an old copy. Codex takes no messages once started (TASK_INPUT is
# ignored): comments that arrive mid-run wait for the next run, which resumes the session.
# shellcheck shell=bash

: "${CODEX_VERSION:?CODEX_VERSION: the Codex version to run}"
export CODEX_HOME=${CODEX_HOME:-/home/node/.codex}
AGENT_STATE=$CODEX_HOME
export AGENT_NAME=Codex

# Model and reasoning effort, from the listener (a tier already resolved, agents/codex.mjs)
# or a comment's /model and /effort. The container is the sandbox: no approvals, no sandbox
# of Codex's own. Its hooks are Deckhand's (hooks.json), trusted as they are.
codex_flags=(
  --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust
  -m "${SANDBOX_MODEL:-gpt-6.1-sol}" -c "model_reasoning_effort=\"${SANDBOX_EFFORT:-medium}\""
)

# A TOML string: JSON's escapes are TOML's.
codex_toml() {
  jq -n --arg value "$1" '$value'
}

# Installed by the listener before the run, like Claude Code (claude.sh).
agent_check() {
  local bin=/opt/codex/$CODEX_VERSION/node_modules/.bin
  [ -x "$bin/codex" ] || agent_missing Codex CODEX_VERSION /opt/codex deckhand-install-codex
  export PATH=$bin:$PATH
  codex_home
}

# Its config and hooks, written again on every start (the header says why).
codex_home() {
  mkdir -p "$CODEX_HOME"
  # Its calls go to the listener (OPENAI_BASE_URL), with the run's agent token as its key; without
  # one (by hand), to OpenAI. Nothing else leaves: no analytics, update check or plugins.
  {
    echo "check_for_update_on_startup = false"
    if [ -n "${OPENAI_BASE_URL:-}" ]; then
      echo 'model_provider = "deckhand"'
    fi
    echo
    echo "[analytics]"
    echo "enabled = false"
    echo
    echo "[features]"
    echo "plugins = false"
    echo "apps = false"
    echo "remote_plugin = false"
    echo
    echo '[projects."/workspace"]'
    echo 'trust_level = "trusted"'
    if [ -n "${OPENAI_BASE_URL:-}" ]; then
      echo
      echo "[model_providers.deckhand]"
      echo 'name = "Deckhand"'
      echo "base_url = $(codex_toml "$OPENAI_BASE_URL")"
      echo 'env_key = "OPENAI_API_KEY"'
      echo 'wire_api = "responses"'
    fi
  } > "$CODEX_HOME/config.toml"
  # The draft pull request after a push and when Codex stops: its hooks take Claude Code's
  # payloads, so draft-pr.sh's hook works as it is.
  cp "$AGENT_FILES/hooks.json" "$CODEX_HOME/hooks.json"
}

# Its global instructions; the repo's own AGENTS.md Codex reads itself.
agent_instructions() {
  cp "$1" "$CODEX_HOME/AGENTS.md"
}

agent_mcp() {
  local name=$1 command=$2 args=() arg
  shift 2
  for arg in "$@"; do args+=("$(codex_toml "$arg")"); done
  printf '\n[mcp_servers.%s]\ncommand = %s\nargs = [%s]\n' \
    "$name" "$(codex_toml "$command")" "$(IFS=,; echo "${args[*]}")" >> "$CODEX_HOME/config.toml"
  # A tool call that waits for a person (deckhand-permissions): Codex cuts one off after 60 s.
  if [ -n "${DECKHAND_MCP_TIMEOUT:-}" ]; then
    printf 'tool_timeout_sec = %s\n' "$DECKHAND_MCP_TIMEOUT" >> "$CODEX_HOME/config.toml"
  fi
}

agent_has_session() {
  compgen -G "$CODEX_HOME/sessions/*/*/*/rollout-*.jsonl" > /dev/null
}

agent_run() {
  local codex=(codex exec)
  case $1 in
    continue) codex+=(resume --last) ;;
    fresh) codex+=(--ephemeral) ;;
  esac
  codex+=(--json "${codex_flags[@]}" "$2")
  # Its JSONL, then a line of Deckhand's with how the turn ended (result.jq); people get
  # progress lines rather than the raw events. Stdin is not Codex's: it would read it as
  # more prompt.
  if [ "${TASK_OUTPUT:-}" = "json" ]; then
    "${codex[@]}" < /dev/null | jq -nRr --unbuffered -f "$AGENT_FILES/result.jq"
  else
    "${codex[@]}" < /dev/null | jq -nRr --unbuffered -f "$AGENT_FILES/result.jq" |
      jq -Rrj --unbuffered -f "$AGENT_FILES/progress.jq"
  fi
  exit "${PIPESTATUS[0]}"
}

agent_interactive() {
  local resume=()
  [ "$1" = continue ] && resume=(resume --last)
  shift
  exec codex "${resume[@]}" "${codex_flags[@]}" "$@"
}
