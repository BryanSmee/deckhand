# Per-repo config: modes

Part of the [`.deckhand.yaml` reference](../repo-config.md): the modes a run is in, a
repository's own (`modes`), and research runs. Reviews, a mode of their own, have
[their page](reviews.md).

## Modes

A run is in a mode: **work** (implement, the default), **brainstorm** (discuss, no code;
it files the follow-up issues the maintainer keeps, like inbox entries and discussions),
**onboarding** (propose this file, see [Onboarding](../repo-config.md#onboarding)), **research** (the open
web, without the code, see [Research](#research)), **review** (a pull request's, when the
`review` block turns it on, see [Reviews](reviews.md#reviews)), **policy** (a dry run of the
[policies](policies.md#a-dry-run-and-the-dashboard), no run), or one of the repository's own, declared under `modes:`. A `/mode <name>` line in a comment
picks one, on its own line or after the trigger on the first one (`Deckhand /mode audit`;
`/mode` is never read as `/model`; names are not case-sensitive):

```text
Deckhand
/mode audit
Focus on the error handling.
```

- **With the trigger line**, it starts that mode. Without one, on an issue that already has
  a session, it **switches**: the new mode goes on in the same session, so it starts from
  the conversation so far, as long as both get the same volumes (what their
  [capabilities](../security.md#capabilities) give). A brainstorm has a clone and session of its
  own, apart from work's, and so does a mode's run without `push`: `/mode work` after a
  read-only audit starts from the issue and its comments, where the audit posted what it found.
- **A comment with neither** goes on in the issue's current mode. The trigger line alone,
  or `/mode work`, goes back to work; `/mode brainstorm` to a brainstorm, which `/stop` wraps
  up. Brainstorms stay on issues ([`run.rego`](policy-inputs.md#the-run-input)).
- **An unknown name** gets a reply listing the modes, and nothing runs. So does a comment
  for a mode that was removed from the config since.
- Work is the default: there is no `default_mode`.

Each mode of `modes:` takes these keys; any other key, a built-in name or a bad path is an
error, listed in the reply:

| Key            | Default  | What                                                                                                                                                                         |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions` | required | Markdown file of the repo, read from the default branch, like `instructions`                                                                                                 |
| `session`      | `issue`  | `issue`: the issue's session, kept; `fresh`: a new one each run, not kept                                                                                                    |
| `agent`        | `agent`  | its agent, among the operator's (see [Agent](../repo-config.md#agent))                                                                                                       |
| `model`        | `model`  | its model                                                                                                                                                                    |
| `effort`       | `effort` | its thinking effort                                                                                                                                                          |
| `speed`        | `normal` | `fast`: Claude Code's fast mode, as with `/speed fast` (which `/speed normal` overrides), within `fast_mode` and the operator's [`SANDBOX_FAST_MODE`](../guides/claude-code.md#fast-mode) |

- **Names**: letters, digits, `-` and `_`. `work` and `brainstorm` can't be redefined (set
  their agent and model with `agent`/`model`/`effort` and `brainstorm_agent`/
  `brainstorm_model`/`brainstorm_effort`);
  `onboarding`, `research`, `stop`, `idea`, `bug`, `discussion`, `analyze`, `review` and
  `policy` are reserved (`review` is set with the `review` block, see [Reviews](reviews.md#reviews);
  `policy` is a [dry run](policies.md#a-dry-run-and-the-dashboard)).
- **Prompt**: the generic sandbox instructions (`prompts/sandbox.md`, and the repo's
  `instructions`) as for every run, then a short frame (the issue or pull request to read,
  what the mode may do) and the mode's file.
- **What its runs may do is the policies'**, never a key: what the sandbox gets
  (`allow_capabilities`: a branch with `push`, `setup`, an engine…), what they write
  (`allow_github`) and push (`allow_push`). Deckhand's `mode-work.rego` gives every repository
  mode work's as the ceiling; the repository's own allow rules in `.deckhand/policy/` give each
  mode its part ([Policies](policies.md#policies), [Capabilities](policies.md#capabilities)). A mode given
  `allow_capabilities` without `push` only reads and answers: no branch, its final message the
  reply, and its prompt says it can't push (and that `setup` was skipped, without `setup`).
  It can run on pull requests, where an audit mode is most useful.
- **`light` is gone** (#498): `modes.<name>.light: true` is an error that stops the
  repository's runs (`false`, what every mode is now, a warning). Remove it, and for a mode that
  only reads and answers, write an `allow_capabilities` rule without `push` (`pull` and the
  `read:*` it needs), and make sure your `allow_github` and `allow_push` rules leave it out: one
  on `input.custom_mode` alone gives it work's writes (issues, pull requests, labels…). A
  policy reading `input.light` is said by the config check: no input has it any more. A run
  without `push` moves no project item and sets no needs-input label; but every repository mode
  now queues as work, takes the needs-input label off as it starts, and waits with
  `wait_for_answers`, as these are decided before its capabilities.
- **Fresh modes** (`session: fresh`) start a new session on every run and don't keep it:
  the issue stays in the mode it was in, and its next run continues its own session.
- **A mode narrows, never widens**: the hosts, mounts and limits of every run of the repo
  are the same whatever the mode (the operator's grants and what they let the repo's
  `mounts` add). A mode has no key for them.
- **It runs once the repository allows it**: `allow_run if input.mode == "audit"` in
  `.deckhand/policy/` ([Policies](policies.md#policies)).

The dashboard names the repo's modes next to the issue, and in each run.

### Research

`/mode research` answers a question from the open web: comparing libraries, reading an API's
docs, a vendor's changelog or terms. Its sandbox reaches any public host (`curl`, Claude
Code's `WebFetch`, the browser), so it gets nothing of the repository's to leak:

- **No code**: no clone, `/workspace` starts empty. Its input is the issue's thread (title,
  description, the last 50 comments), which Deckhand writes into the run's inbox.
- **No GitHub token**: the broker refuses it one, so `gh` and `git` can't reach the
  repository, and it can't push. Its final message is its reply, posted by Deckhand.
- **Nothing else of the repo's**: the base image (never `dockerfile` or a branch's), no
  `setup`, `caches`, `instructions`, host mounts, container engine or screenshots.
- **Its own session**, apart from work's and the light runs' (a page could leave anything
  there): comments without a trigger or `/mode` line go on in it, `/mode work` switches.

It only runs where the operator grants it: `research`, an `allow_grant` rule of their policies
([the grants](../security.md#the-grants)). Without it,
`/mode research` gets a reply naming the grant, and nothing runs. Its agent and model are
those of brainstorms (`brainstorm_agent`, `brainstorm_model`).
