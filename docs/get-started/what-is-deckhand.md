# What is Deckhand

Deckhand runs Claude Code on your GitHub issues and pull requests. You comment `Deckhand` on an
issue; it starts a sandbox, works on a branch, opens a draft pull request and answers on the
issue when it is done, or stops to ask when only you can decide.

It is self-hosted and bring-your-own-key: you create your own private GitHub App, run your own
server (Docker Compose, or [Kubernetes](../kubernetes.md)), and use your own Claude credential.
It can run [Codex](../guides/codex.md) or the [Antigravity CLI](../guides/antigravity.md)
instead. One deployment serves one operator, across as many repositories as the App is
installed on.

## What it does

- **Comment triggers.** The first line of a comment is the command, the rest are instructions.
  `Deckhand` starts a run; later comments on the issue or its pull request continue the same
  session. `/mode brainstorm` discusses the issue without code, `/after #77` waits for another
  issue, `/cancel` stops the run ([Comment commands](../reference/comment-commands.md)).
- **Needs input.** A run that hits a decision only you can make pushes its work in progress,
  asks numbered questions and labels the issue `needs-input`. Your answer continues it.
- **Live feedback.** Reactions on your comment (👀, then 🚀, 😕 or 👎), and the final message as a
  comment from the App's bot.
- **Onboarding.** A repository without a `.deckhand.yaml` gets an issue where Claude proposes
  one, grounded in the repository ([Onboarding](../repo-config.md#onboarding)).
- **Reviews.** A review of each pull request, and fixes for what it finds, when the repository
  turns them on ([Reviews](../repo-config/reviews.md#reviews)).
- **Inboxes.** An ideas issue and a bugs issue whose comments become filed issues
  ([Inboxes](../repo-config/issues.md#inboxes)).
- **Your own machines.** Issues that need what only your computer has can run there, with your
  own Claude Code ([Your own machine](../guides/machines.md)).
- **Dashboard.** Every issue and pull request Deckhand worked on, its runs' live logs, and what
  waits for what ([The dashboard](../guides/dashboard.md)).

## What it is not

- **Not a hosted service.** Nothing runs on anyone's servers but yours, and nobody else holds
  your keys.
- **Not unattended on anyone's comments.** Only the GitHub logins you allow start runs; others
  are ignored.
- **Not trusting the agent.** Claude Code runs without permission prompts, so Deckhand limits
  what a sandbox can reach instead: no GitHub token, no host paths, a network that only reaches
  the hosts you allow ([Security model](../security.md)).

## Claude Code and naming

Deckhand runs Claude Code; it is not made by or affiliated with Anthropic. Claude Code is not
bundled in any image: it installs on first start, at a pinned version. Each operator uses their
own Claude credential, under their own agreement with Anthropic, and follows Anthropic's
[Usage Policy](https://www.anthropic.com/legal/aup).

Next: the [quick start](quick-start.md), then the [core ideas](core-ideas.md).
