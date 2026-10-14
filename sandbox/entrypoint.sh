#!/bin/bash
# Installs Claude Code on first use (CLAUDE_CODE_VERSION, into the shared /opt/claude-code
# volume: no image ships it), clones the repository over HTTPS (tokens from the listener's
# broker, git-credential-deckhand), opens the task's branch and draft pull request
# (draft-pr.sh, for TASK_ISSUE; skipped with SANDBOX_LIGHT=1), then runs Claude without
# permission prompts: the container is the sandbox.
#
#   (no arguments)      interactive claude
#   -p "<task>" …       arguments for claude, e.g. a headless task
#   bash, git log…      any other command, run in the clone
set -euo pipefail

: "${REPO_URL:?REPO_URL: the repository to clone (https://github.com/owner/repo.git)}"
: "${BASE_BRANCH:=main}"
: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION: the Claude Code version to run}"

# TASK_INPUT=stream (the webhook listener): stdin carries comments that arrive while Claude
# works, as stream-json user messages. Set it aside on fd 3 so no setup command reads them.
if [ "${TASK_INPUT:-}" = "stream" ]; then
  exec 3<&0 < /dev/null
fi

# One folder per version in the volume, installed aside then renamed, so two first runs at
# once can't leave a half-installed copy behind.
claude_home=/opt/claude-code/$CLAUDE_CODE_VERSION
if [ ! -x "$claude_home/node_modules/.bin/claude" ]; then
  tmp=$(mktemp -d /opt/claude-code/.install-XXXXXX)
  npm install --prefix "$tmp" --no-fund --no-audit --loglevel=error \
    "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" > /tmp/claude-install.log 2>&1 ||
    { cat /tmp/claude-install.log >&2; rm -rf "$tmp"; exit 1; }
  mv -T "$tmp" "$claude_home" 2> /dev/null || rm -rf "$tmp" # another run got there first
fi
export PATH=$claude_home/node_modules/.bin:$PATH

if [ ! -d /workspace/.git ]; then
  # Blobless clone: full history for git log/blame, file contents fetched on demand. The
  # checkout's blob fetch ignores --quiet, so its output is only shown on failure.
  git clone --filter=blob:none --branch "$BASE_BRANCH" "$REPO_URL" /workspace \
    > /tmp/clone.log 2>&1 || { cat /tmp/clone.log >&2; exit 1; }
fi
cd /workspace
# Every start, not just the clone's: the hook may change with the image.
cp /usr/local/share/git-hooks/pre-push /workspace/.git/hooks/pre-push

if [ -n "${SANDBOX_LIGHT:-}" ]; then
  # A brainstorm reads the code and doesn't run it, so it answers quickly. Fresh
  # origin/<base> to read, and the base branch itself when nothing is in progress on it.
  git fetch --quiet origin
  if [ "$(git branch --show-current)" = "$BASE_BRANCH" ] && git diff --quiet HEAD; then
    git merge --ff-only "origin/$BASE_BRANCH" > /dev/null 2>&1 || true
  fi
else
  # The task's branch and draft pull request first, so the run shows up on GitHub within
  # seconds (does nothing outside work runs on an issue).
  sandbox-draft-pr start
fi

# Copied on every start rather than baked into ~/.claude: that directory is a per-issue
# volume, which would keep an old copy forever.
cp /usr/local/share/deckhand-sandbox.md "$CLAUDE_CONFIG_DIR/CLAUDE.md"
if ! claude mcp get playwright > /dev/null 2>&1; then
  claude mcp add --scope user playwright -- playwright-mcp --headless --isolated \
    --browser chromium --output-dir /tmp/playwright > /dev/null
fi

# Model and thinking effort, from the listener's defaults or a comment's /model and /effort.
model=(--model "${SANDBOX_MODEL:-opus}" --effort "${SANDBOX_EFFORT:-medium}")

if [ $# -eq 0 ] && [ -n "${TASK_PROMPT:-}" ]; then
  # The volumes keep the session between runs: the first run starts on TASK_PROMPT, later
  # ones continue with TASK_MESSAGE, or interactively without one. TASK_MODE is "work"
  # (implement, the default) or "brainstorm" (discuss, no code); both share the issue's
  # session, so an implementation starts with what a brainstorm settled.
  mode=${TASK_MODE:-work}
  resume=()
  prompt=$TASK_PROMPT
  if compgen -G "$CLAUDE_CONFIG_DIR/projects/-workspace/*.jsonl" > /dev/null; then
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
  echo "$mode" > "$CLAUDE_CONFIG_DIR/sandbox-mode"
  # TASK_OUTPUT=json (the webhook listener) reads the raw events; people get progress lines.
  if [ "${TASK_OUTPUT:-}" = "json" ] && [ "${TASK_INPUT:-}" = "stream" ]; then
    # The prompt is the first message, then each comment the listener writes; closing stdin
    # ends the session once Claude has answered. A process substitution rather than a pipe:
    # if Claude exits early, the container stops instead of waiting on `cat`.
    exec claude --dangerously-skip-permissions "${model[@]}" "${resume[@]}" -p \
      --input-format stream-json --output-format stream-json --verbose \
      < <(
        jq -nc --arg text "$prompt" '{type: "user", message: {role: "user", content: $text}}'
        cat <&3
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
