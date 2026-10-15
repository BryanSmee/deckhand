#!/bin/bash
# Loads the run's agent (SANDBOX_AGENT, claude by default, or codex: agents/<name>.sh, which
# finds its CLI in its shared, read-only volume, installed by the listener), clones the
# repository over HTTPS (tokens from the listener's broker, git-credential-deckhand), opens the task's branch
# and draft pull request (draft-pr.sh, for TASK_ISSUE), runs the repo's setup command
# (SANDBOX_SETUP), then runs the agent without permission prompts: the container is the
# sandbox. With DOCKER_HOST (a run granted a container engine), the docker CLI goes through
# the egress proxy and waits for the engine before the setup. SANDBOX_LIGHT=1 (brainstorms, inbox entries, discussions) skips the branch and the
# setup.
#
#   (no arguments)      the agent, interactive
#   -p "<task>" …       arguments for the agent's CLI, e.g. a headless task
#   bash, git log…      any other command, run in the clone
set -euo pipefail

: "${REPO_URL:?REPO_URL: the repository to clone (https://github.com/owner/repo.git)}"
: "${BASE_BRANCH:=main}"

# TASK_INPUT=stream (the webhook listener): comments that arrive while the agent works, as
# its messages, from the run's inbox (TASK_INBOX, followed by deckhand-inbox until the
# listener closes it) or else stdin. Stdin is set aside on fd 3 so no setup command reads it.
if [ "${TASK_INPUT:-}" = "stream" ]; then
  exec 3<&0 < /dev/null
fi
deckhand_messages() {
  if [ -n "${TASK_INBOX:-}" ]; then deckhand-inbox "$TASK_INBOX"; else cat <&3; fi
}

# Everything that is the agent's own, in the image or, run from a checkout, next to this file.
: "${SANDBOX_AGENT:=claude}"
agents=/usr/local/share/deckhand-agents
[ -d "$agents" ] || agents=$(dirname "$(readlink -f "$0")")/agents
if [[ ! "$SANDBOX_AGENT" =~ ^[a-z0-9-]+$ ]] || [ ! -f "$agents/$SANDBOX_AGENT.sh" ]; then
  echo "Unknown agent $SANDBOX_AGENT (SANDBOX_AGENT): no $agents/$SANDBOX_AGENT.sh" >&2
  exit 1
fi
AGENT_FILES=$agents/$SANDBOX_AGENT
# shellcheck source=agents/claude.sh
source "$agents/$SANDBOX_AGENT.sh"
agent_check

if [ ! -d /workspace/.git ]; then
  # Blobless clone: full history for git log/blame, file contents fetched on demand. The
  # checkout's blob fetch ignores --quiet, so its output is only shown on failure.
  git clone --filter=blob:none --branch "$BASE_BRANCH" "$REPO_URL" /workspace \
    > /tmp/clone.log 2>&1 || { cat /tmp/clone.log >&2; exit 1; }
fi
cd /workspace
# Every start, not just the clone's: the hook may change with the image.
cp /usr/local/share/git-hooks/pre-push /workspace/.git/hooks/pre-push
# The broker's tokens only read: pushes go through the listener's git gateway, which refuses
# the base branch whatever the hook above says (../listener/git-gateway.mjs). Not for light
# runs, which the gateway refuses anyway: their push fails on the read-only token instead,
# with GitHub's clear "permission denied".
if [ -n "${DECKHAND_BROKER_URL:-}" ] && [ -z "${SANDBOX_LIGHT:-}" ]; then
  git config --global "url.$DECKHAND_BROKER_URL/git/.pushInsteadOf" "${REPO_URL%/*/*}/"
fi

# The run's container engine (../listener/runner/engine.mjs): the containers it builds and
# runs get the egress proxy by address (from the docker CLI's config), since they can't
# resolve names on the run's network. Then the engine gets a minute to come up, so the
# setup can use it.
if [ -n "${DOCKER_HOST:-}" ]; then
  if [ -n "${HTTPS_PROXY:-}" ]; then
    rest=${HTTPS_PROXY#*://}
    host=${rest%%[:/]*}
    address=$(getent hosts "$host" | awk '{ print $1; exit }') || true
    proxy=${HTTPS_PROXY/"$host"/${address:-$host}}
    proxy=${proxy%/}
    mkdir -p "$HOME/.docker"
    jq -n --arg proxy "$proxy" \
      '{ proxies: { default: { httpProxy: $proxy, httpsProxy: $proxy, noProxy: "localhost,127.0.0.1" } } }' \
      > "$HOME/.docker/config.json"
  fi
  for _ in $(seq 60); do
    docker version > /dev/null 2>&1 && break
    sleep 1
  done
  docker version > /dev/null 2>&1 \
    || echo "The container engine at $DOCKER_HOST doesn't answer yet" >&2
fi

if [ -n "${SANDBOX_LIGHT:-}" ]; then
  # A light run reads the code and doesn't run it, so it answers quickly. Fresh
  # origin/<base> to read, and the base branch itself when nothing is in progress on it.
  git fetch --quiet origin
  if [ "$(git branch --show-current)" = "$BASE_BRANCH" ] && git diff --quiet HEAD; then
    git merge --ff-only "origin/$BASE_BRANCH" > /dev/null 2>&1 || true
  fi
else
  # The task's branch and draft pull request first, so the run shows up on GitHub within
  # seconds (does nothing outside work runs on an issue).
  sandbox-draft-pr start
  # The repo's own setup (its config's `setup`: dependencies, services…), on stderr so its
  # output never reads as the agent's. A failure doesn't stop the run: the agent is told.
  if [ -n "${SANDBOX_SETUP:-}" ]; then
    echo "Setup: $SANDBOX_SETUP" >&2
    if ! bash -c "$SANDBOX_SETUP" >&2; then
      setup_failed="The repository's setup command failed before you started (its output is in
the run's log): $SANDBOX_SETUP
Check what it should have prepared before relying on it."
    fi
  fi
fi

# Deckhand's rules, then the project's part (its config's `instructions`), from the default
# branch like the config: a branch can't rewrite the rules it runs under.
instructions=$(mktemp)
cp /usr/local/share/deckhand-sandbox.md "$instructions"
if [ -n "${SANDBOX_INSTRUCTIONS:-}" ]; then
  git fetch --quiet origin "$BASE_BRANCH" 2> /dev/null || true
  if extra=$(git show "origin/$BASE_BRANCH:$SANDBOX_INSTRUCTIONS" 2> /dev/null); then
    printf '\n# This project\n\n%s\n' "$extra" >> "$instructions"
  else
    echo "Instructions file $SANDBOX_INSTRUCTIONS not found on $BASE_BRANCH" >&2
  fi
fi
agent_instructions "$instructions"
rm -f "$instructions"
# Added again on every start: the proxy settings may change between runs. Chromium gets the
# egress proxy as flags rather than from HTTP(S)_PROXY, which it doesn't reliably read.
browser=(--headless --isolated --browser chromium --output-dir /tmp/playwright)
if [ -n "${HTTPS_PROXY:-}" ]; then
  browser+=(--proxy-server "$HTTPS_PROXY" --proxy-bypass "${NO_PROXY:-localhost}")
fi
agent_mcp playwright playwright-mcp "${browser[@]}"

if [ $# -eq 0 ] && [ -n "${TASK_PROMPT:-}" ]; then
  # The volumes keep the session between runs: the first run starts on TASK_PROMPT, later
  # ones continue with TASK_MESSAGE, or interactively without one. TASK_MODE is "work"
  # (implement, the default), "brainstorm" (discuss, no code) or one of the repo's own modes
  # (its config's `modes:`); they share the issue's session, so each starts with what the
  # previous one settled. Light runs (SANDBOX_LIGHT) get volumes of their own from the
  # listener, so they never continue work's session, nor work theirs. "discussion" keeps its
  # own session. TASK_SESSION=fresh ("idea" and
  # "bug", the inbox entries, and the repo's fresh modes) starts a new one every time, and
  # doesn't keep it: the issue's session stays the one the next run continues.
  # TASK_SESSION=new starts a new one that the next run continues: an agent taking over from
  # another after a fallback, which an older session of its own would mislead.
  mode=${TASK_MODE:-work}
  session=new # new, continue, or fresh: not kept
  prompt=$TASK_PROMPT
  if [ "${TASK_SESSION:-}" = fresh ] || [ "$mode" = idea ] || [ "$mode" = bug ]; then
    session=fresh
  fi
  if [ "$session" = new ] && [ "${TASK_SESSION:-}" != new ] && agent_has_session; then
    session=continue
    if [ -z "${TASK_MESSAGE:-}" ]; then
      agent_interactive continue
    fi
    previous=$(cat "$AGENT_STATE/sandbox-mode" 2> /dev/null || echo work)
    if [ "$previous" != "$mode" ]; then
      prompt="Until now this session was in $previous mode on this issue. New task, building on
that conversation:

$TASK_PROMPT

Also take this into account: $TASK_MESSAGE"
    elif [ "$mode" = brainstorm ]; then
      prompt="New comment on the issue: $TASK_MESSAGE

(Still a brainstorm: no code, branch, commit, pull request or new issue.)"
    elif [ "$mode" = discussion ]; then
      prompt="New comment in the discussion: $TASK_MESSAGE

(Still the discussion: no code, branch, commit or pull request.)"
    elif [ "$mode" != work ]; then
      # One of the repo's modes: its instructions came with its first prompt in this session.
      prompt="New comment: $TASK_MESSAGE

(Still in the $mode mode: follow its instructions.)"
    else
      prompt="New feedback on this issue: $TASK_MESSAGE

Address it, run the checks again, then commit and push to the same branch so the pull
request updates (the sandbox opens a draft one for a pushed branch that has none). If it is
still a draft and the work is done, update its description and mark it ready with
\`gh pr ready\`. Before marking it ready, bring the branch up to date: \`git fetch origin\`,
\`git rebase origin/$BASE_BRANCH\`, resolve any conflicts, run the checks again, then
\`git push --force-with-lease\` (rewriting history is fine on this branch only). If a
conflict can't be resolved safely (both sides changed the same behaviour, say), or the
feedback raises a blocker only the maintainer can resolve (contradictory feedback, say), stop and ask instead: see \"Stopping to ask\" in your instructions."
    fi
  elif [ -n "${TASK_MESSAGE:-}" ]; then
    prompt+="

Also take this into account: $TASK_MESSAGE"
  fi
  if [ -n "${setup_failed:-}" ]; then
    prompt+="

$setup_failed"
  fi
  [ "$session" = fresh ] || echo "$mode" > "$AGENT_STATE/sandbox-mode"
  agent_run "$session" "$prompt"
fi

if [ $# -eq 0 ] || [[ "$1" == -* ]]; then
  agent_interactive new "$@"
fi
exec "$@"
