# Your own machine

A task can run on one of your own computers rather than in a sandbox: one with what a sandbox
doesn't have (a game engine and its editor, a GPU, licensed tools, large local assets). Its
driver, `deckhand-machine`, signs in as you, claims the issues routed to it and runs your own
Claude Code there; Deckhand keeps the rest (the queue, the issue's comments, needs-input, the
review loop, the dashboard).

> **Warning**: an agent will run on this machine on its own, with your files, credentials and
> network. Deckhand suggests settings for it and enforces none: what it may do there is up to
> you. Give it a machine, or an account on one, that holds nothing you wouldn't hand it.

## Set it up

It needs Node 20 or later, git (signed in to GitHub as you: the driver pushes with it) and
Claude Code, signed in, on Windows, macOS or Linux. Claude Code's sandbox needs `bubblewrap` and
`socat` on Linux and WSL2 (`apt install bubblewrap socat`); macOS has what it needs; native
Windows has none (WSL2 has).

1. The repository takes machines: the operator's `machines` grant
   ([security.md](../security/policies.md#the-grants)) and a `machines:` block in its `.deckhand.yaml`
   ([repo-config/issues.md](../repo-config/issues.md#machines)).
2. Download `deckhand-machine.mjs` (attached to each release; `machine/` in this repository) and
   sign in, which shows the warning and waits for you to type `yes`, then opens your browser:

   ```sh
   node deckhand-machine.mjs login https://deckhand.example.com
   ```

3. Write `machine.yaml` in its folder (`~/.deckhand-machine`, or `DECKHAND_MACHINE_HOME`):

   ```yaml
   name: studio # unique among your machines
   labels: [unreal, gpu] # what a repository's machines.labels and runs-on:<label> name
   capacity: 1 # runs at once
   repos: [acme/game] # "owner/name" or "owner/*"
   workspace: ~/deckhand # its clones: <workspace>/<owner>/<repo>/issue-<n>, kept between runs
   paths: # reachable by its agent besides its clone: read-only unless write
     - path: C:\Program Files\Epic Games\UE_5.4
     - path: D:\DerivedDataCache
       write: true
   deny: [~/clients] # unreadable too, with the usual credential stores
   # claude: claude                # its command (on Windows, claude.exe's full path), or a list
   # model: opus                   # effort: high
   # permission_mode: acceptEdits  # dontAsk, plan…: never bypassPermissions
   # sandbox: true                 # Claude Code's sandbox, where it has one
   # suggested_settings: true      # false: your own Claude Code settings alone
   # git_url: git@github.com:{repo}.git   # where to clone from: GitHub's https URL by default
   ```

4. Run it, in a terminal or as a service of your own (Ctrl-C gives its runs back):

   ```sh
   node deckhand-machine.mjs run
   ```

   Its first `run` shows the warning again and waits for `yes`. It registers the machine (it
   shows in Settings › MCP clients), says it is there every 30 s and claims what is routed to it:
   a `runs-on:<label>` label or a `/machine` comment
   ([repo-config/issues.md](../repo-config/issues.md#routing-an-issue-to-a-machine)).

## How a run goes

Each run fetches the repository into its clone, checks out the issue's branch (as it is on
GitHub, ahead of it after a push that failed, or new from the base; one that went another way
than GitHub's copy is put back on it, its own commits kept on a `<branch>-before-<run>` branch, as is one GitHub no longer has once
the driver had pushed it all: the run starts again from the base),
and runs `claude -p` there, its output sent to Deckhand as the
run's log and the comments that reach it written to its input; `--resume` goes on with the
issue's session when the machine ran it before. Then the driver pushes the branch with your git
(with a lease on GitHub's copy as it fetched it: a rebase goes, never over a push made meanwhile;
the clone's own git hooks are never run) and ends the run, naming the branch and its head: the
App opens its pull request, ready for review when the run ended well without asking, a draft
otherwise; Deckhand posts the reply and opens the pull request.

## The suggested settings

For each run the driver writes Claude Code settings
(`runs/<run>.settings.json` in its folder, which says the Claude Code version they were checked
against), passed with `--settings`: above your user and the repository's settings, whose deny
rules still add up. They:

- let it write in the run's clone (not its `.git` folder with its file tools: hooks and config
  there would run as you), and reach `paths` (read-only unless `write`);
- deny reading the usual credential stores (`~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`,
  `~/.gnupg`, `~/.config/gh`, `~/.git-credentials`, `~/.netrc`, `~/.docker/config.json`,
  Claude Code's own credentials file…), your browsers' profiles and keychains, the driver's
  folder (its sign-in) and `deny`;
- give its sandbox the hosts a sandbox run of the repository may reach as its only domains: the
  agent's, GitHub's and the operator's grant (a grant of `*`, any host, gives no list: Claude
  Code's own default and your settings decide);
- turn its sandbox on where Claude Code has one, refusing to start without it
  (`failIfUnavailable`), and `bypassPermissions` off: what its permission mode would ask you
  goes to `approve_permission` (above), through the driver itself run as Claude Code's
  permission prompt tool, which holds no token.

What they don't stop: they are Claude Code's to apply, not Deckhand's. The sandbox confines the
commands it runs and their network, the permission rules its file tools; neither covers your
MCP servers, hooks or plugins, git's credential helpers (a keychain), nor what you allow in your
own settings. On Windows there is no sandbox: its commands run with your rights. With
`suggested_settings: false`, only your own settings apply.

## How it ran

Each claim reports Claude Code's version, whether its sandbox is on, its
permission mode and whether the suggested settings are used. The run's log, its page and its
reply's footer say them ("on studio (v2.1.3, sandbox on, `acceptEdits`, Deckhand's settings, as it
reports)"): what the machine reports, not something Deckhand checked.
