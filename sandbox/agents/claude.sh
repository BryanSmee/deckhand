# Claude Code, the sandbox's half of the agent seam (../../listener/agents/claude.mjs is the
# listener's). Sourced by entrypoint.sh, which picks it from SANDBOX_AGENT and calls, in order:
#
#   agent_check                      the CLI is installed (or a clear message), and on PATH
#   agent_instructions <file>        Deckhand's rules and the project's, for every session
#   agent_mcp <name> <command> …     an MCP server, added again on every start
#   agent_has_session                whether the issue's volume has a session to continue
#   agent_run <session> <prompt>     headless: session is "new", "continue" or "fresh" (not
#                                    kept); TASK_OUTPUT=json prints the raw output the
#                                    listener normalizes (Claude Code's stream-json),
#                                    TASK_INPUT=stream also reads deckhand_messages (the inbox:
#                                    comments that arrive mid-run) if the agent takes them
#   agent_interactive <session> …    by hand: "continue" or "new", with claude's arguments
#
# and keeps its own state in AGENT_STATE, a folder of the issue's session volume.
# shellcheck shell=bash

: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION: the Claude Code version to run}"
# Run as `node` (uid 1000): Claude refuses --dangerously-skip-permissions as root anyway.
# Its non-essential traffic (telemetry, updates) off: the version is pinned.
export CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/home/node/.claude}
export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
AGENT_STATE=$CLAUDE_CONFIG_DIR
# Its name in what the sandbox writes for it (the draft pull request).
export AGENT_NAME=Claude

# Model and thinking effort, from the listener (a tier already resolved, agents/claude.mjs)
# or a comment's /model and /effort.
claude_model=(--model "${SANDBOX_MODEL:-opus}" --effort "${SANDBOX_EFFORT:-medium}")
# Fast mode (/speed fast), for this session only: flag settings aren't saved to the issue's
# volume. Its organization check calls api.anthropic.com with the sandbox's stand-in for the
# credential, which can only fail: skipped, the API itself refuses fast mode when the
# organization doesn't allow it. Claude Code ignores the skip with an OAuth token.
if [ "${SANDBOX_SPEED:-}" = fast ]; then
  claude_model+=(--settings '{"fastMode": true}')
  export CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1
fi
# Its own fallback when that model is overloaded (CLAUDE_FALLBACK_MODEL), headless only, and
# never the model itself, which Claude Code refuses.
claude_fallback=()
if [ -n "${SANDBOX_FALLBACK_MODEL:-}" ] && [ "$SANDBOX_FALLBACK_MODEL" != "${SANDBOX_MODEL:-opus}" ]; then
  claude_fallback=(--fallback-model "$SANDBOX_FALLBACK_MODEL")
fi

# Installed by the listener before the run (entrypoint.sh's agent_missing says how otherwise).
agent_check() {
  local bin=/opt/claude-code/$CLAUDE_CODE_VERSION/node_modules/.bin
  [ -x "$bin/claude" ] ||
    agent_missing "Claude Code" CLAUDE_CODE_VERSION /opt/claude-code deckhand-install-claude-code
  export PATH=$bin:$PATH
}

# Copied on every start rather than baked into ~/.claude: that directory is a per-issue
# volume, which would keep an old copy forever.
agent_instructions() {
  cp "$1" "$CLAUDE_CONFIG_DIR/CLAUDE.md"
}

agent_mcp() {
  local name=$1
  shift
  claude mcp remove --scope user "$name" > /dev/null 2>&1 || true
  claude mcp add --scope user "$name" -- "$@" > /dev/null
}

agent_has_session() {
  compgen -G "$CLAUDE_CONFIG_DIR/projects/-workspace/*.jsonl" > /dev/null
}

agent_run() {
  local resume=()
  case $1 in
    continue) resume=(--continue) ;;
    fresh) resume=(--no-session-persistence) ;;
  esac
  local prompt=$2
  # Headless, the session ends at the turn's end: subagents and commands it would leave
  # running in the background answer too late, or keep it going after its answer (#204).
  export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
  local claude=(claude --dangerously-skip-permissions "${claude_model[@]}" "${claude_fallback[@]}"
    "${resume[@]}" -p)
  if [ "${TASK_OUTPUT:-}" = "json" ] && [ "${TASK_INPUT:-}" = "stream" ]; then
    # The prompt is the first message, then each comment the listener writes; closing the
    # inbox (or stdin) ends the session once Claude has answered. A process substitution
    # rather than a pipe: if Claude exits early, the container stops instead of waiting.
    exec "${claude[@]}" --input-format stream-json --output-format stream-json --verbose \
      < <(
        jq -nc --arg text "$prompt" '{type: "user", message: {role: "user", content: $text}}'
        deckhand_messages
      )
  fi
  if [ "${TASK_OUTPUT:-}" = "json" ]; then
    exec "${claude[@]}" "$prompt" --output-format stream-json --verbose
  fi
  # People get progress lines rather than the raw events.
  "${claude[@]}" "$prompt" --output-format stream-json --verbose |
    jq -Rrj --unbuffered -f "$AGENT_FILES/progress.jq"
  exit "${PIPESTATUS[0]}"
}

agent_interactive() {
  local resume=()
  [ "$1" = continue ] && resume=(--continue)
  shift
  exec claude --dangerously-skip-permissions "${claude_model[@]}" "${resume[@]}" "$@"
}
