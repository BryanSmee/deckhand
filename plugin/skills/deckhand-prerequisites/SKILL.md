---
name: deckhand-prerequisites
description: Step 1 of setting up Deckhand. Checks the machine (Linux, macOS, or WSL2 with Docker Desktop), Docker Engine 26+ with the compose plugin, git, curl and the GitHub CLI, then finds or clones the Deckhand folder. Use alone to check a machine before installing Deckhand.
---

# Deckhand: prerequisites

Checks what Deckhand needs on this machine and finds (or makes) the Deckhand folder, the clone
of `BryanSmee/deckhand` that holds `compose.yaml`. Read-only until the clone, which asks
first. The reference: `docs/guides/install.md` (or
https://bryansmee.github.io/deckhand/guides/install).

Never ask for, read or print a secret here; nothing in this step needs one.

## 1. The system

Run `uname -s` and `cat /proc/version 2>/dev/null`:

- **Linux**: fine. **Darwin** (macOS): fine, with Docker Desktop (or another engine giving
  `docker`).
- **Linux with `microsoft` in `/proc/version`**: WSL2. Docker must be Docker Desktop's, with
  _Settings › Resources › WSL integration_ on for this distribution. The Deckhand folder goes
  in the Linux file system (`~/deckhand`), never under `/mnt/c/…`: Windows' drives keep no
  file modes, and are slow from WSL.
- **MINGW, MSYS, CYGWIN, or a PowerShell prompt**: native Windows isn't supported. Tell the
  user to install WSL2 (`wsl --install` in an administrator PowerShell, then a restart) and
  Docker Desktop with its WSL integration, then run this skill again in the WSL shell.

A laptop is fine to try Deckhand: runs stop while it sleeps, and the next start picks them
up.

## 2. Docker

```sh
docker version --format '{{.Server.Version}}'
docker compose version --short
```

- The server version must be **26 or later**, and `docker compose` the compose plugin (v2: a
  version, not "unknown command"). `docker-compose` (with a dash) doesn't count.
- "permission denied … docker.sock": the user isn't in the `docker` group. On Linux, they run
  `sudo usermod -aG docker "$USER"` themselves, then sign out and in again (or `newgrp docker`).
- "Cannot connect to the Docker daemon": Docker isn't running. Docker Desktop: start it. Linux:
  `sudo systemctl enable --now docker`, run by the user.
- Not installed: Docker's own instructions for the system
  (https://docs.docker.com/engine/install/ for Linux, Docker Desktop for macOS and Windows).
  Installing needs `sudo` or an installer: give the user the commands to run themselves rather
  than running `sudo` yourself, then check again.

Kubernetes instead (`kubectl` and `helm`): out of this skill's scope, see `docs/kubernetes.md`.

## 3. The tools

- `git --version` and `curl --version`: required.
- `gh --version`, then `gh api user --jq .login`: the GitHub CLI signed in gives the user's
  login (step 3) and lets the last step check the first run. Optional: without it, ask the
  login and check GitHub in the browser. Never run `gh auth token` or `gh auth status -t`.

## 4. The Deckhand folder

Look for it, in that order: the current directory, then `~/deckhand`. It is the one where
`git remote get-url origin` names `deckhand` and `compose.yaml` and `.env.example` exist.

- Found: say where, and its `git log -1 --format='%h %cs'`. Don't pull or switch branches
  without asking.
- Not found: ask where to put it (default `~/deckhand`), then
  `git clone https://github.com/BryanSmee/deckhand.git <folder>`.

Every later step runs from that folder. Tell the user its path, and `cd` there.
