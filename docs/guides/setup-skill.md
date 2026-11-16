# Set up with Claude Code

The [quick start](../get-started/quick-start.md)'s steps, done with you by your own Claude Code:
the `setup-deckhand` skill checks the machine, puts your credential in place, writes the server
folder, gives Deckhand a public address (or sets it up without one, in pull mode), starts it, opens the GitHub App's setup and follows a
first `Deckhand` comment to its answer. Each step checks what is already done first, so running
it again picks up where you left.

It runs on Linux, macOS, and Windows through WSL2 with Docker Desktop (in a WSL shell: native
Windows isn't supported), with Docker Compose. On a cluster, see
[Deckhand on Kubernetes](../kubernetes.md).

## Install it

The skill comes as a Claude Code plugin from this repository, which is its own plugin
marketplace (`.claude-plugin/marketplace.json`). In Claude Code:

```text
/plugin marketplace add BryanSmee/deckhand
/plugin install deckhand@deckhand
```

That follows `main`. To keep the skill to a release's docs and `compose.yaml`, add the
marketplace at its tag instead, `BryanSmee/deckhand@v1.2.3`, from the releases that include it.
`/plugin marketplace update deckhand` takes the latest commit of what you added.

Then, in any folder:

```text
/deckhand:setup-deckhand
```

## The steps

`/deckhand:setup-deckhand` runs these in order; each is a skill of its own, which you can run alone
(`/deckhand:deckhand-endpoint` to change the public address, say):

| Skill                    | What it does                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deckhand-prerequisites` | Docker 26+ and compose, git, curl, the GitHub CLI; finds or clones the Deckhand folder                                                                                                                |
| `deckhand-credentials`   | a Claude plan's token or an API key (or Codex's, or the Antigravity CLI's) in `.env` or [the credentials folder](agents.md#the-credentials-folder)                                                    |
| `deckhand-server-folder` | `server/` from `server.example/`, your login in `allowed_users`, `allowed_repos`, the agent                                                                                                           |
| `deckhand-endpoint`      | a stable public address: your own, [Tailscale Funnel, a cloudflared named tunnel or an ngrok static domain](tunnels.md), or none in [pull mode](tunnels.md#no-public-address-pull-mode); `public_url` |
| `deckhand-launch`        | `docker compose up`, the [GitHub App](github-app.md) and its installation, then a first `Deckhand /mode brainstorm` comment followed to its reply                                                     |

## What stays yours

- **Secrets never enter the conversation.** The skill never reads `.env` or the credentials
  folder: it checks which names are set, not their values (`plugin/scripts/deckhand-env check`),
  and gives you a command to run in **your own terminal** (not with `!` in Claude Code, whose
  output enters the conversation), which asks for the value without showing it and appends it
  to `.env`. A secret pasted into the conversation anyway: revoke it and make another.
- **The setup link is never printed.** It carries the one-time token that creates the App: the
  skill opens it in your browser (`plugin/scripts/deckhand-open-setup`), or, on a server without
  a browser, tells you what to run to get it yourself.
- **Your clicks stay yours.** Creating the GitHub App and installing it grant permissions on
  your account: the skill says what each page shows, you click. It asks before posting
  anything on GitHub (the test issue and its comment).
- **`sudo` stays yours.** Installing Docker, joining the `docker` group, a tunnel's service:
  the skill gives the commands, you run them.

The skill follows these docs rather than copying them: each step names the page it relies on,
which Claude reads from the Deckhand folder when your case goes beyond it.
