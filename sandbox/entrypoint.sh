#!/bin/bash
# Finds Claude Code (CLAUDE_CODE_VERSION, in the shared /opt/claude-code volume, read-only:
# no image ships it, the listener installs it with install-claude-code), clones the
# repository over HTTPS (tokens from the listener's broker, git-credential-deckhand), opens
# the task's branch and draft pull request (draft-pr.sh, for TASK_ISSUE), runs the repo's
# setup command (SANDBOX_SETUP), then runs Claude without permission prompts: the container
# is the sandbox. SANDBOX_LIGHT=1 (brainstorms, inbox entries, discussions) skips the branch
# and the setup.
#
#   (no arguments)      interactive claude
#   -p "<task>" …       arguments for claude, e.g. a headless task
#   bash, git log…      any other command, run in the clone
set -euo pipefail

: "${REPO_URL:?REPO_URL: the repository to clone (https://github.com/owner/repo.git)}"
: "${BASE_BRANCH:=main}"
: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION: the Claude Code version to run}"

# TASK_INPUT=stream (the webhook listener): comments that arrive while Claude works, as
# stream-json user messages, from the run's inbox (TASK_INBOX, followed by deckhand-inbox
# until the listener closes it) or else stdin. Stdin is set aside on fd 3 so no setup
# command reads it.
if [ "${TASK_INPUT:-}" = "stream" ]; then
  exec 3<&0 < /dev/null
fi

# Installed by the listener before the run. The volume is read-only here, so a sandbox
# started by hand can't install it: say so rather than fail later on a missing command.
claude_bin=/opt/claude-code/$CLAUDE_CODE_VERSION/node_modules/.bin
if [ ! -x "$claude_bin/claude" ]; then
  echo "Claude Code $CLAUDE_CODE_VERSION is not installed in /opt/claude-code. The listener" \
    "installs it before a run; by hand, run deckhand-install-claude-code as root" \
    "(docker run --user 0 --entrypoint deckhand-install-claude-code" \
    "-e CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION -v <volume>:/opt/claude-code <image>)." >&2
  exit 1
fi
export PATH=$claude_bin:$PATH

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
# the base branch whatever the hook above says (../listener/git-gateway.mjs).
if [ -n "${DECKHAND_BROKER_URL:-}" ]; then
  git config --global "url.$DECKHAND_BROKER_URL/git/.pushInsteadOf" "${REPO_URL%/*/*}/"
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
  # output never reads as Claude's. A failure doesn't stop the run: Claude is told.
  if [ -n "${SANDBOX_SETUP:-}" ]; then
    echo "Setup: $SANDBOX_SETUP" >&2
    if ! bash -c "$SANDBOX_SETUP" >&2; then
      setup_failed="The repository's setup command failed before you started (its output is in
the run's log): $SANDBOX_SETUP
Check what it should have prepared before relying on it."
    fi
  fi
fi

# Copied on every start rather than baked into ~/.claude: that directory is a per-issue
# volume, which would keep an old copy forever.
cp /usr/local/share/deckhand-sandbox.md "$CLAUDE_CONFIG_DIR/CLAUDE.md"
# The project's part (its config's `instructions`), from the default branch like the config:
# a branch can't rewrite the rules it runs under.
if [ -n "${SANDBOX_INSTRUCTIONS:-}" ]; then
  git fetch --quiet origin "$BASE_BRANCH" 2> /dev/null || true
  if extra=$(git show "origin/$BASE_BRANCH:$SANDBOX_INSTRUCTIONS" 2> /dev/null); then
    printf '\n# This project\n\n%s\n' "$extra" >> "$CLAUDE_CONFIG_DIR/CLAUDE.md"
  else
    echo "Instructions file $SANDBOX_INSTRUCTIONS not found on $BASE_BRANCH" >&2
  fi
fi
# Added again on every start: the proxy settings may change between runs. Chromium gets the
# egress proxy as flags rather than from HTTP(S)_PROXY, which it doesn't reliably read.
browser=(--headless --isolated --browser chromium --output-dir /tmp/playwright)
if [ -n "${HTTPS_PROXY:-}" ]; then
  browser+=(--proxy-server "$HTTPS_PROXY" --proxy-bypass "${NO_PROXY:-localhost}")
fi
claude mcp remove --scope user playwright > /dev/null 2>&1 || true
claude mcp add --scope user playwright -- playwright-mcp "${browser[@]}" > /dev/null

# Model and thinking effort, from the listener's defaults or a comment's /model and /effort.
model=(--model "${SANDBOX_MODEL:-opus}" --effort "${SANDBOX_EFFORT:-medium}")

if [ $# -eq 0 ] && [ -n "${TASK_PROMPT:-}" ]; then
  # The volumes keep the session between runs: the first run starts on TASK_PROMPT, later
  # ones continue with TASK_MESSAGE, or interactively without one. TASK_MODE is "work"
  # (implement, the default), "brainstorm" (discuss, no code) or one of the repo's own modes
  # (its config's `modes:`); they share the issue's session, so each starts with what the
  # previous one settled. "discussion" keeps its own session. TASK_SESSION=fresh ("idea" and
  # "bug", the inbox entries, and the repo's fresh modes) starts a new one every time, and
  # doesn't keep it: the issue's session stays the one the next run continues.
  mode=${TASK_MODE:-work}
  resume=() # session options: --continue, or none kept for a fresh one
  prompt=$TASK_PROMPT
  fresh=
  if [ "${TASK_SESSION:-}" = fresh ] || [ "$mode" = idea ] || [ "$mode" = bug ]; then
    fresh=1
    resume=(--no-session-persistence)
  fi
  if [ -z "$fresh" ] &&
    compgen -G "$CLAUDE_CONFIG_DIR/projects/-workspace/*.jsonl" > /dev/null; then
    resume=(--continue)
    if [ -z "${TASK_MESSAGE:-}" ]; then
      exec claude --dangerously-skip-permissions "${model[@]}" --continue
    fi
    previous=$(cat "$CLAUDE_CONFIG_DIR/sandbox-mode" 2> /dev/null || echo work)
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
\`gh pr ready\`. If it raises a blocker only the maintainer can resolve (contradictory
feedback, say), stop and ask instead: see \"Stopping to ask\" in CLAUDE.md."
    fi
  elif [ -n "${TASK_MESSAGE:-}" ]; then
    prompt+="

Also take this into account: $TASK_MESSAGE"
  fi
  if [ -n "${setup_failed:-}" ]; then
    prompt+="

$setup_failed"
  fi
  [ -n "$fresh" ] || echo "$mode" > "$CLAUDE_CONFIG_DIR/sandbox-mode"
  # TASK_OUTPUT=json (the webhook listener) reads the raw events; people get progress lines.
  if [ "${TASK_OUTPUT:-}" = "json" ] && [ "${TASK_INPUT:-}" = "stream" ]; then
    # The prompt is the first message, then each comment the listener writes; closing the
    # inbox (or stdin) ends the session once Claude has answered. A process substitution
    # rather than a pipe: if Claude exits early, the container stops instead of waiting.
    exec claude --dangerously-skip-permissions "${model[@]}" "${resume[@]}" -p \
      --input-format stream-json --output-format stream-json --verbose \
      < <(
        jq -nc --arg text "$prompt" '{type: "user", message: {role: "user", content: $text}}'
        if [ -n "${TASK_INBOX:-}" ]; then deckhand-inbox "$TASK_INBOX"; else cat <&3; fi
      )
  fi
  if [ "${TASK_OUTPUT:-}" = "json" ]; then
    exec claude --dangerously-skip-permissions "${model[@]}" "${resume[@]}" -p "$prompt" \
      --output-format stream-json --verbose
  fi
  claude --dangerously-skip-permissions "${model[@]}" "${resume[@]}" -p "$prompt" \
    --output-format stream-json --verbose |
    jq -Rrj --unbuffered -f /usr/local/share/deckhand-progress.jq
  exit "${PIPESTATUS[0]}"
fi

if [ $# -eq 0 ] || [[ "$1" == -* ]]; then
  exec claude --dangerously-skip-permissions "${model[@]}" "$@"
fi
exec "$@"
