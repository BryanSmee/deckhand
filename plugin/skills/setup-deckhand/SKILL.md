---
name: setup-deckhand
description: Set up a self-hosted Deckhand from nothing to a first answered `Deckhand` comment, on Docker Compose (Linux, macOS, or Windows through WSL2). Use when the user wants to install, set up or finish setting up Deckhand. Runs the step skills in order, skipping what is already done, and keeps every secret out of the conversation.
---

# Set up Deckhand

Deckhand runs Claude Code on GitHub issues, on the user's own server, through their own
private GitHub App. This skill takes them from nothing to a first `Deckhand` comment answered,
in five steps, each a skill of its own that can also run alone and starts by checking what is
already done:

| Step | Skill                    | Done when                                                                                                                   |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | `deckhand-prerequisites` | Docker 26+ and compose answer, and a Deckhand folder exists                                                                 |
| 2    | `deckhand-credentials`   | `.env` (or the credentials folder) has an agent credential                                                                  |
| 3    | `deckhand-server-folder` | `server/config.yaml` lists the user in `allowed_users`                                                                      |
| 4    | `deckhand-endpoint`      | `public_url` is set and `<public_url>/health` answers through the internet, or pull mode chosen (a local `http://` address) |
| 5    | `deckhand-launch`        | the App is installed and a `Deckhand` comment got its answer                                                                |

Run them in that order with the Skill tool (as `deckhand:<skill>`, the plugin's names). Before each, say in one line what it does; after
each, say what it found or changed. When a step is already done, say so and go on. When the
user stops halfway, the next `/deckhand:setup-deckhand` picks up where they left: every step checks
first.

## Rules for every step

- **No secret enters the conversation.** Never read, `cat`, `grep` the values of, or edit
  `.env` with a file tool, nor the credentials folder's files. Check secrets with
  `deckhand-env check` (names only), and have the user set them in their own terminal with
  `deckhand-env set`, which asks with a hidden prompt (the step skills give the command).
  If the user pastes a secret into the conversation anyway, tell them to revoke it and make a
  new one: it is now in the transcript.
- **The setup link is never printed**: it carries the token that creates the App. Never run
  `docker compose logs edge` unfiltered: use `docker compose logs edge | grep -v 'setup?token='`.
  `deckhand-open-setup` opens it in the browser.
- **The user's clicks stay theirs**: creating the GitHub App and installing it grant
  permissions on their account. Open the pages; the user reads and clicks. Ask before posting
  anything on GitHub (an issue, a comment).
- **The docs are the reference**, in the Deckhand folder's `docs/` (and at
  https://bryansmee.github.io/deckhand/): read the page a step links when the user's case
  goes beyond the skill, rather than guessing.
- **Kubernetes** is out of this skill's scope: when the user wants a cluster rather than
  Compose, point them to `docs/kubernetes.md` and stop.
- **Windows**: through WSL2 with Docker Desktop's WSL integration only, in a WSL shell
  (`deckhand-prerequisites` checks it). Native Windows isn't supported.

The helpers: `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env` and
`sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-open-setup`, run from the Deckhand folder.

## At the end

Sum up in a few lines: where the Deckhand folder is, the public address, the App's
installation, the issue with the first answer, and what to read next: `docs/repo-config.md`
(a repository's `.deckhand.yaml`, which the onboarding issue proposes),
`docs/reference/comment-commands.md`, `docs/security.md` (before installing the App on a
repository other people write to), and `docs/guides/updating.md`.
