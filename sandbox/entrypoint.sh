#!/bin/bash
# Loads the run's agent (SANDBOX_AGENT, claude by default, codex or antigravity: agents/<name>.sh, which
# finds its CLI in its shared, read-only volume, installed by the listener), clones the
# repository over HTTPS (through the listener's GitHub gateway, git-credential-deckhand), opens the task's branch
# and draft pull request (draft-pr.sh, for TASK_ISSUE), runs the repo's setup command
# (SANDBOX_SETUP), then runs the agent without permission prompts: the container is the
# sandbox. With DOCKER_HOST (a run granted a container engine), the docker CLI goes through
# the egress proxy and waits for the engine before the setup; every prompt ends with whether
# the run has one. SANDBOX_LIGHT=1 (brainstorms, inbox entries, discussions) skips the branch and the
# setup. SANDBOX_NO_CLONE=1 (research runs: the open internet, nothing from GitHub) skips the clone
# and git's credential helper too: the agent starts in an empty /workspace. SANDBOX_FULL_CLONE=1
# (a work run that isn't a fork's) clones whole, and makes a kept blobless clone whole.
#
#   (no arguments)      the agent, interactive
#   -p "<task>" …       arguments for the agent's CLI, e.g. a headless task
#   bash, git log…      any other command, run in the clone
set -euo pipefail

: "${REPO_URL:?REPO_URL: the repository to clone (https://github.com/owner/repo.git)}"
: "${BASE_BRANCH:=main}"

# TASK_INPUT=stream (the webhook listener): comments that arrive while the agent works, as
# its messages, from the run's inbox (TASK_INBOX, the broker's URL for it, followed by
# deckhand-inbox until the listener closes it) or else stdin. Stdin is set aside on fd 3 so no setup command reads it.
if [ "${TASK_INPUT:-}" = "stream" ]; then
  exec 3<&0 < /dev/null
fi
deckhand_messages() {
  if [ -n "${TASK_INBOX:-}" ]; then deckhand-inbox "$TASK_INBOX"; else cat <&3; fi
}

# The run's files on the broker (../listener/run-files.mjs), rather than in a volume shared
# with the listener: the egress proxy's CA and the run's digest, fetched once into files of
# the sandbox's own, which DECKHAND_CA and TASK_DIGEST then name. A path (a sandbox started by
# hand) is used as it is. Without them the run can't do its job: it stops (set -e). `$1`: the
# folder (/tmp/deckhand, reserved in repo-config.mjs).
fetch_run_files() {
  local var name
  for var in DECKHAND_CA:egress-ca.crt TASK_DIGEST:digest.md; do
    name=${var%%:*}
    if [[ "${!name:-}" == http://* || "${!name:-}" == https://* ]]; then
      mkdir -p "$1"
      deckhand-files get "${!name}" "$1/${var#*:}"
      export "$name=$1/${var#*:}"
    fi
  done
}
fetch_run_files /tmp/deckhand

# Screenshots (SCREENSHOT_DIR, a folder of the sandbox's own): uploaded to the broker every
# few seconds while the agent works (and by the agent's Stop hook, each push and the gh
# wrapper before each call: draft-pr.sh, pre-push, gh), served under SCREENSHOT_URL. On stderr: stdout is the agent's.
if [ -n "${SCREENSHOT_DIR:-}" ]; then
  mkdir -p "$SCREENSHOT_DIR"
  [ -z "${DECKHAND_BROKER_URL:-}" ] || deckhand-files shots --watch >&2 < /dev/null &
fi

# The egress proxy's CA (DECKHAND_CA, a file from the listener for every run that reaches
# GitHub, whose calls the proxy relays to the listener's GitHub gateway, and when the
# repository's grant has cached_hosts or the agent's calls are relayed to the listener): the
# proxy decrypts those hosts' HTTPS to hand it to the listener, or to cache it. Trusted next to the
# image's own roots, in a bundle of ours (`node` can't run update-ca-certificates), through
# the variables each tool reads, and by Chromium, which reads its own store (~/.pki/nssdb).
if [ -n "${DECKHAND_CA:-}" ] && [ -f "$DECKHAND_CA" ]; then
  bundle=$HOME/.deckhand/ca-bundle.crt
  mkdir -p "${bundle%/*}"
  for roots in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
    if [ -f "$roots" ]; then
      cat "$roots" > "$bundle"
      break
    fi
  done
  { echo; cat "$DECKHAND_CA"; } >> "$bundle"
  export NODE_EXTRA_CA_CERTS=$DECKHAND_CA SSL_CERT_FILE=$bundle CURL_CA_BUNDLE=$bundle \
    GIT_SSL_CAINFO=$bundle REQUESTS_CA_BUNDLE=$bundle PIP_CERT=$bundle
  # Replaced, not added again: a new proxy volume is a new CA.
  if command -v certutil > /dev/null; then
    nss=$HOME/.pki/nssdb
    mkdir -p "$nss"
    {
      { [ -f "$nss/cert9.db" ] || certutil -d "sql:$nss" -N --empty-password; } \
        && { certutil -d "sql:$nss" -D -n "Deckhand egress CA" 2> /dev/null || true; } \
        && certutil -d "sql:$nss" -A -t "C,," -n "Deckhand egress CA" -i "$DECKHAND_CA"
    } || echo "Chromium doesn't trust the egress proxy's CA: cached hosts fail in it" >&2
  fi
fi

# Everything that is the agent's own, in the image or, run from a checkout, next to this file.
: "${SANDBOX_AGENT:=claude}"
agents=/usr/local/share/deckhand-agents
[ -d "$agents" ] || agents=$(dirname "$(readlink -f "$0")")/agents
if [[ ! "$SANDBOX_AGENT" =~ ^[a-z0-9-]+$ ]] || [ ! -f "$agents/$SANDBOX_AGENT.sh" ]; then
  echo "Unknown agent $SANDBOX_AGENT (SANDBOX_AGENT): no $agents/$SANDBOX_AGENT.sh" >&2
  exit 1
fi
AGENT_FILES=$agents/$SANDBOX_AGENT
# For agent_check: the listener installs the agent before a run, into a volume a sandbox
# mounts read-only, so a sandbox started by hand can't. Say how instead of failing later on
# a missing command. Arguments: its name, the variable with its version, the volume's mount
# and the installer.
agent_missing() {
  local name=$1 var=$2 root=$3 installer=$4
  echo "$name ${!var} is not installed in $root. The listener installs it before a run; by" \
    "hand, run $installer as root (docker run --user 0 --entrypoint $installer" \
    "-e $var=${!var} -v <volume>:$root <image>)." >&2
  exit 1
}
# shellcheck source=agents/claude.sh
source "$agents/$SANDBOX_AGENT.sh"
agent_check

if [ -n "${SANDBOX_NO_CLONE:-}" ]; then
  # Nothing to clone (the GitHub gateway refuses this run): an empty helper list, so git asks
  # nobody.
  git config --global credential.helper ""
elif [ ! -d /workspace/.git ]; then
  # Blobless clone: full history for git log/blame, file contents fetched on demand. The
  # checkout's blob fetch ignores --quiet, so its output is only shown on failure. Whole for a
  # work run that isn't a fork's: the GitHub gateway refuses it a blob fetched on its own, which
  # may be a fork's (listener/github-forks.mjs).
  filter=(--filter=blob:none)
  [ -z "${SANDBOX_FULL_CLONE:-}" ] || filter=()
  git clone "${filter[@]}" --branch "$BASE_BRANCH" "$REPO_URL" /workspace \
    > /tmp/clone.log 2>&1 || { cat /tmp/clone.log >&2; exit 1; }
fi
cd /workspace

# A kept clone may hold what the last run checked out: a fork's pull request, read by a review
# or worked on. Setup and the agent's project hooks (.claude/settings.json…) run on what is
# checked out, before anyone reads it, so every start goes back to trusted code, with nothing
# untracked or ignored left: a work run's branch when it tracks one of the repository's own
# (the task's, or a pull request's from the repository: `gh pr checkout` sets a fork's to
# its URL, or to refs/pull/<n>/head) and has no commit that isn't on the repository, else the
# base branch. The branch left behind stays, and a work run's uncommitted changes are stashed:
# the agent is told (reset_from, reset_stashed) and takes them back if it needs them.
reset_clone() {
  local branch target=$BASE_BRANCH
  clean_git_dir
  whole_clone
  # Reviews read pull requests in worktrees under /tmp, gone with their container: a stale
  # one would keep its branch from being checked out here.
  git worktree prune
  branch=$(git branch --show-current)
  if [ -z "${SANDBOX_LIGHT:-}" ] && [ -n "$branch" ] &&
    [ "$(git config "branch.$branch.remote")" = origin ] &&
    [[ "$(git config "branch.$branch.merge")" == refs/heads/* ]] &&
    [ -z "$(git rev-list HEAD --not --remotes=origin)" ]; then
    target=$branch
  fi
  # Told to the agent if it is still elsewhere when it starts (draft-pr.sh may go back).
  [ "$branch" = "$target" ] || reset_from=$branch
  if [ -z "${SANDBOX_LIGHT:-}" ] && [ -n "$(git status --porcelain)" ] &&
    git stash push --quiet --include-untracked -m "Left uncommitted by a run, on ${branch:-a detached HEAD}"; then
    reset_stashed=1
  fi
  if ! git checkout --quiet --force "$target" 2> /dev/null; then
    # Gone from the clone (a base branch renamed since, say): fresh from the repository.
    git fetch --quiet origin "$BASE_BRANCH"
    git checkout --quiet --force -B "$BASE_BRANCH" "origin/$BASE_BRANCH"
  fi
  git clean -ffdxq
}

# A kept clone a fork's run or an older Deckhand made blobless, in a work run that
# isn't a fork's (SANDBOX_FULL_CLONE): the blobs it lacks fetched once, whole (--refetch, git
# 2.36), before any checkout would ask for them one by one, which the GitHub gateway refuses
# such a run. What the repository's branches don't reach (a local branch or a stash whose
# commits aren't on them: force-pushed away, a fork's merged in) stays missing: counted, and the
# agent told (reset_missing), rather than a checkout of it failing on a refusal later.
whole_clone() {
  [ -n "${SANDBOX_FULL_CLONE:-}" ] || return 0
  [ -n "$(git config remote.origin.partialclonefilter || true)" ] || return 0
  git fetch --quiet --refetch --no-filter origin '+refs/heads/*:refs/remotes/origin/*'
  git config --unset remote.origin.partialclonefilter
  reset_missing=$(git rev-list --objects --missing=print --all 2> /dev/null | grep -c '^?' || true)
  [ "${reset_missing:-0}" != 0 ] || reset_missing=
}

# .git is the volume's too, and a fork's code that ran in a work run could have written in
# it what git runs: hooks, and settings (core.fsmonitor, core.hooksPath, filter drivers,
# include.path, a config.worktree…). Emptied for good, not just for the reset's commands:
# draft-pr.sh checks out after it. The config keeps only what the clone needs; the pre-push
# hook is copied back below.
clean_git_dir() {
  local config=.git/config kept entry key
  kept=$(mktemp)
  while IFS= read -r -d '' entry; do
    key=${entry%%$'\n'*}
    case $key in
      core.repositoryformatversion | core.filemode | core.bare | core.logallrefupdates | \
        core.ignorecase | core.precomposeunicode | core.symlinks | extensions.objectformat | \
        extensions.partialclone | extensions.refstorage | \
        remote.origin.promisor | remote.origin.partialclonefilter | remote.origin.gh-resolved | \
        branch.*.remote | branch.*.merge)
        git config --file "$kept" --add "$key" "${entry#*$'\n'}"
        ;;
    esac
  done < <(git config --file "$config" --null --list)
  git config --file "$kept" remote.origin.url "$REPO_URL"
  # The clone's own refspec, git's default: one widened to refs/pull/* would have every fetch
  # want the forks' pull requests, which the GitHub gateway refuses a work run.
  git config --file "$kept" remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  mv "$kept" "$config"
  rm -f .git/config.worktree
  rm -rf .git/hooks
  mkdir .git/hooks
}
[ -n "${SANDBOX_NO_CLONE:-}" ] || reset_clone

# Every start, not just the clone's: the hook may change with the image.
[ -n "${SANDBOX_NO_CLONE:-}" ] || cp /usr/local/share/git-hooks/pre-push /workspace/.git/hooks/pre-push
# The GitHub gateway's tokens only read, and it refuses pushes: they go through the listener's
# git gateway, which refuses the base branch whatever the hook above says
# (../listener/git-gateway.mjs). Not for light runs, which the git gateway refuses anyway: their
# push fails at the GitHub gateway instead.
if [ -n "${DECKHAND_BROKER_URL:-}" ] && [ -z "${SANDBOX_LIGHT:-}" ] && [ -z "${SANDBOX_NO_CLONE:-}" ]; then
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
fi

# What the agent is told about the engine, at the end of every prompt (a continued session
# too): the docker CLI is in every image, so finding it tells the agent nothing.
engine_note() {
  if [ -z "${DOCKER_HOST:-}" ]; then
    echo "This run has no container engine: \`docker\` can't build or start anything here."
  elif docker version > /dev/null 2>&1; then
    echo "This run has a container engine: \`docker\`, \`docker buildx\` and \`docker compose\`
work (DOCKER_HOST=$DOCKER_HOST), and published ports answer on \`engine\`, not
\`localhost\`. Build and start the images your change touches."
  else
    echo "The container engine at $DOCKER_HOST doesn't answer yet" >&2
    echo "This run was given a container engine (DOCKER_HOST=$DOCKER_HOST), but it didn't
answer \`docker version\` before you started. Retry \`docker version\` before giving up on
it, and if it never answers, say so in your final message."
  fi
}
engine=$(engine_note)

if [ -n "${SANDBOX_NO_CLONE:-}" ]; then
  : # Nothing to fetch, set up or open.
elif [ -n "${SANDBOX_LIGHT:-}" ]; then
  # A light run reads the code and doesn't run it, so it answers quickly. Fresh
  # origin/<base> to read, and the base branch itself (reset_clone() put it there).
  git fetch --quiet origin
  git merge --ff-only "origin/$BASE_BRANCH" > /dev/null 2>&1 || true
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

(Still a brainstorm: no code, branch, commit or pull request, and new issues only for kept follow-ups.)"
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
  # Light runs read pull requests in worktrees (review.md), and leave nothing to take back.
  if [ -z "${SANDBOX_LIGHT:-}" ] && [ -n "${reset_from:-}" ] &&
    [ "$(git branch --show-current)" != "$reset_from" ]; then
    prompt+="

The clone in /workspace was put back on \`$(git branch --show-current)\` before you started,
with nothing untracked: the last run left it on \`$reset_from\`, which isn't a branch of this
repository or has commits that aren't on it (still there). Check it out again
(\`gh pr checkout <n>\` for a pull request) if you need it."
  fi
  if [ -n "${reset_missing:-}" ]; then
    prompt+="

The clone in /workspace was made whole before you started (every blob of the repository's
branches fetched at once), but $reset_missing objects of its local branches or stash, which no
branch of the repository has, are still missing. This run can't fetch them one by one (they may
be a fork's): a checkout or diff that needs them fails. Leave those branches alone; a maintainer
can ask for work on a fork's pull request from that pull request."
  fi
  if [ -n "${reset_stashed:-}" ]; then
    prompt+="

What the last run left uncommitted in the clone was stashed before you started
(\`git stash list\`, the latest entry): \`git stash pop\` if you need it."
  fi
  if [ -n "${setup_failed:-}" ]; then
    prompt+="

$setup_failed"
  fi
  prompt+="

$engine"
  [ "$session" = fresh ] || echo "$mode" > "$AGENT_STATE/sandbox-mode"
  agent_run "$session" "$prompt"
fi

if [ $# -eq 0 ] || [[ "$1" == -* ]]; then
  agent_interactive new "$@"
fi
exec "$@"
