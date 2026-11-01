# The Antigravity CLI (`agy`), the sandbox's half of the agent seam
# (../../listener/agents/antigravity.mjs is the listener's). Sourced by entrypoint.sh, with the
# same functions as claude.sh (see there).
#
# Its home, ~/.gemini, is the issue's session volume: its token file, settings, MCP servers and
# hooks are written again on every start, so the volume never keeps an old copy. The token file
# holds the run's agent token, never the plan's login: the egress proxy hands the calls that carry it
# to the listener, which puts the plan's access token in its place. `agy -p` takes no messages
# once started (TASK_INPUT is ignored): comments that arrive mid-run wait for the next run,
# which resumes the conversation.
# shellcheck shell=bash

: "${AGY_VERSION:?AGY_VERSION: the Antigravity CLI version to run}"
AGY_HOME=$HOME/.gemini
AGENT_STATE=$AGY_HOME
export AGENT_NAME="Antigravity CLI"
# The version is pinned: no update check.
export AGY_CLI_DISABLE_AUTO_UPDATE=1

# The model, from the listener (a tier already resolved, agents/antigravity.mjs) or a comment's
# /model. The plan names each with its effort (gemini-4-argon-high): a name without one takes
# the run's effort (low, medium or high).
agy_model() {
  local model=${SANDBOX_MODEL:-gemini-4-argon-medium}
  case $model in
    *-low | *-medium | *-high) echo "$model" ;;
    *) echo "$model-${SANDBOX_EFFORT:-medium}" ;;
  esac
}

# On a Gemini API key, agy 1.4.0's catalog has no Gemini 4 Argon
# (google-antigravity/antigravity-cli#1228): agy_home declares it as a custom model, which takes
# its effort from --effort (Google's thinkingLevel) rather than from its name.
AGY_KEY_MODEL=gemini-4-argon

# The model's flags: on a key, Argon's suffix becomes its --effort. One argument per line.
agy_model_args() {
  local model
  model=$(agy_model)
  if [ -n "${GEMINI_API_KEY:-}" ] && [[ $model =~ ^$AGY_KEY_MODEL-(low|medium|high)$ ]]; then
    printf '%s\n' --model "$AGY_KEY_MODEL" --effort "${BASH_REMATCH[1]}"
  else
    printf '%s\n' --model "$model"
  fi
}

# Installed by the listener before the run, like Claude Code (claude.sh).
agent_check() {
  local bin=/opt/antigravity/$AGY_VERSION/bin
  [ -x "$bin/agy" ] ||
    agent_missing "Antigravity CLI" AGY_VERSION /opt/antigravity deckhand-install-antigravity
  export PATH=$bin:$PATH
  agy_home
}

# Its token file, settings, MCP servers and hooks, written again on every start (the header
# says why).
agy_home() {
  local cli=$AGY_HOME/antigravity-cli config=$AGY_HOME/config settings
  mkdir -p "$cli" "$config"
  settings=$(cat "$cli/settings.json" 2> /dev/null || echo '{}')
  # With a Gemini API key (the run's agent token in GEMINI_API_KEY, and GOOGLE_GEMINI_BASE_URL),
  # `agy` calls the Gemini API directly without signing in when modelProvider is "gemini".
  # Otherwise the run's agent token (DECKHAND_AGENT_TOKEN) goes in its token file, with an expiry `agy` never reaches;
  # without the listener (by hand), the token file is yours. The clone is trusted.
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    rm -f "$cli/antigravity-oauth-token"
    jq --arg id "$AGY_KEY_MODEL" '.modelProvider = "gemini"
      | .customModelsConfig.customModels[$id] = {modelId: $id, modelName: "gemini-api://\($id)",
          label: "Gemini 4 Argon", apiProvider: "API_PROVIDER_GOOGLE_GEMINI", maxTokens: 1048576,
          modelFeatures: {supportsImages: true, supportsPdf: true, supportsToolCalls: true,
            supportsThinking: true, zeroShotCapable: true}}
      | .trustedWorkspaces = ((.trustedWorkspaces // []) - ["/workspace"] + ["/workspace"])' \
      <<< "$settings" > "$cli/settings.json" 2> /dev/null ||
      echo '{"modelProvider":"gemini","trustedWorkspaces":["/workspace"]}' > "$cli/settings.json"
  else
    local token=${DECKHAND_AGENT_TOKEN:-}
    if [ -n "$token" ]; then
      (
        umask 077
        jq -n --arg token "$token" '{auth_method: "consumer", token: {
          access_token: $token, token_type: "Bearer", refresh_token: "deckhand-placeholder",
          expiry: "2099-01-01T00:00:00Z"}}' > "$cli/antigravity-oauth-token"
      )
    fi
    jq --arg id "$AGY_KEY_MODEL" 'del(.modelProvider, .customModelsConfig.customModels[$id])
      | if .customModelsConfig == {customModels: {}} then del(.customModelsConfig) else . end
      | .trustedWorkspaces = ((.trustedWorkspaces // []) - ["/workspace"] + ["/workspace"])' \
      <<< "$settings" > "$cli/settings.json" 2> /dev/null ||
      echo '{"trustedWorkspaces":["/workspace"]}' > "$cli/settings.json"
  fi
  echo '{"mcpServers":{}}' > "$config/mcp_config.json"
  # The draft pull request when it stops: its user-level hooks, not the workspace's
  # .agents/hooks.json, which would land in the repo.
  cp "$AGENT_FILES/hooks.json" "$config/hooks.json"
}

# Its global rules; the repo's own AGENTS.md `agy` reads itself.
agent_instructions() {
  cp "$1" "$AGY_HOME/AGENTS.md"
}

agent_mcp() {
  local name=$1 command=$2 file=$AGY_HOME/config/mcp_config.json args='[]' arg servers
  shift 2
  # One at a time: jq would read an argument such as --headless as its own option.
  for arg in "$@"; do args=$(jq -c --arg arg "$arg" '. + [$arg]' <<< "$args"); done
  servers=$(jq --arg name "$name" --arg command "$command" --argjson args "$args" \
    '.mcpServers[$name] = {command: $command, args: $args, env: {}}' < "$file")
  echo "$servers" > "$file"
}

# The conversation the issue's runs continue: the one its last kept run started or resumed.
agent_has_session() {
  [ -s "$AGY_HOME/deckhand-conversation" ]
}

agy_conversation() {
  cat "$AGY_HOME/deckhand-conversation"
}

agent_run() {
  local agy=(agy -p "$2" --output-format stream-json --dangerously-skip-permissions) model out
  local status=0 id
  mapfile -t model < <(agy_model_args)
  agy+=("${model[@]}")
  [ "$1" = continue ] && agy+=(--conversation "$(agy_conversation)")
  out=$(mktemp)
  # Its stream-json with each answer's text joined (text.jq); people get progress lines rather
  # than the raw events. Stdin is not `agy`'s.
  if [ "${TASK_OUTPUT:-}" = "json" ]; then
    "${agy[@]}" < /dev/null | jq -nRr --unbuffered -f "$AGENT_FILES/text.jq" | tee "$out" ||
      status=${PIPESTATUS[0]}
  else
    "${agy[@]}" < /dev/null | jq -nRr --unbuffered -f "$AGENT_FILES/text.jq" | tee "$out" |
      jq -Rrj --unbuffered -f "$AGENT_FILES/progress.jq" || status=${PIPESTATUS[0]}
  fi
  # The conversation the next run resumes; a fresh one (an inbox entry) isn't kept.
  if [ "$1" != fresh ]; then
    id=$(jq -Rr 'fromjson? | select(.event == "init") | .conversation_id // empty' "$out" | head -1)
    [ -z "$id" ] || { mkdir -p "$AGY_HOME" && echo "$id" > "$AGY_HOME/deckhand-conversation"; }
  fi
  rm -f "$out"
  # Its Stop hook opens the draft pull request; again once it exits, should the hook not have
  # run (it does nothing when there is one).
  sandbox-draft-pr hook Stop > /dev/null 2>&1 || true
  exit "$status"
}

agent_interactive() {
  local resume=() model
  [ "$1" = continue ] && resume=(--conversation "$(agy_conversation)")
  shift
  mapfile -t model < <(agy_model_args)
  exec agy "${resume[@]}" --dangerously-skip-permissions "${model[@]}" "$@"
}
