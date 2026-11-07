# Antigravity CLI

Deckhand can run Google's [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli)
(`agy`), with a Gemini API key (or [a Google AI plan](#with-a-google-ai-plan)). In `.env`:

```sh
GEMINI_API_KEY=AIza…
```

and in `config.yaml`, to make it the default (or let repositories pick it, as with [Codex](codex.md)):

```yaml
sandbox_agent: antigravity
sandbox_model: best # gemini-4-argon-high; balanced and fast: gemini-4-argon-medium, gemini-3.8-flash-medium
```

On a key, `agy` 1.4.0 doesn't list Gemini 4 Argon yet
([google-antigravity/antigravity-cli#1228](https://github.com/google-antigravity/antigravity-cli/issues/1228)):
the sandbox declares it as a custom model in `agy`'s settings, and passes an Argon tier's
effort as `--effort` (`gemini-4-argon-high` runs `--model gemini-4-argon --effort high`). The
other models (`agy models`) need nothing.

`SANDBOX_AGENT=antigravity` without `GEMINI_API_KEY` (or a Google AI plan's login) stops the
orchestrator at start.

As with Claude Code and Codex, the key never enters a sandbox: `agy` calls the models service
(`GOOGLE_GEMINI_BASE_URL=<broker>/google`) with the run's agent token in `GEMINI_API_KEY` (and
`modelProvider: "gemini"` in its settings), and the models service forwards the call to Google (or
your `GEMINI_BASE_URL`) with yours.

## What differs from Claude Code

What differs from Claude Code, as for Codex:

- **Comments that arrive mid-run** wait for the run to end: `agy -p` takes no more input. The
  next run resumes the same conversation (`agy --conversation <id>`).
- **Sessions** are in a volume per issue, `<sandbox>-antigravity` (`~/.gemini`).
- **Instructions:** Deckhand's rules and the repository's `instructions` file go to
  `~/.gemini/AGENTS.md`; `agy` reads the repository's own `AGENTS.md` itself.
- **Draft pull request:** a `Stop` hook in `agy`'s user-level hooks (`~/.gemini/config/hooks.json`,
  not the repository's `.agents/hooks.json`), and again once it exits.
- **A failed command** shows as any other in the run's log: `agy`'s output doesn't say a
  command failed.

## With a Google AI plan

Instead of an API key, the Antigravity CLI can run on a Google AI Pro or Ultra plan's login,
which gives it Gemini 4 Argon (and the plan's other models: `agy models` lists them). Only
`agy` takes such a plan: Gemini CLI and the gateways need an API key.

Google's terms may not allow a plan, licensed to one person, to drive an automated bot:
check them before you set this up. The orchestrator's log warns about it at each start.

On a plan, `agy` has no setting to send its calls to the models service, so its login is kept out
of the sandboxes another way. The models service holds it; each sandbox gets a token file whose
access token is the run's agent token. For these runs only, the egress proxy decrypts the two
hosts that carry the token (`daily-cloudcode-pa.googleapis.com`, `www.googleapis.com`) and hands
each request to the models service, which checks the token, puts the plan's access token in its place and sends the
call on, on the paths `agy` uses only. `agy`'s telemetry (`play.googleapis.com`, which carries
the token too) is refused; its feature flags (`antigravity-unleash.goog`) and your avatar
(`lh3.googleusercontent.com`, which its eligibility check fetches) go through untouched. See
[Security model](../security/models.md#the-antigravity-clis-login).

1. Sign in once, for Deckhand alone, in a container (any machine with Docker; the image is
   Deckhand's sandbox image, which has what `agy` needs):

   ```sh
   docker volume create agy-sign-in
   docker run --rm -it --user 0 --entrypoint deckhand-install-antigravity \
     -e AGY_VERSION=1.4.0 \
     -e AGY_SHA256=x64:fd96967583c1eed94733c039638fa59b71ddbd823c75ebc8dd0e677463565aad,arm64:cf953adcc69f87d00d71f97c3f35dc723a8669a350accf9a199df781f0523f56 \
     -v deckhand-antigravity:/opt/antigravity ghcr.io/bryansmee/deckhand-sandbox
   docker run --rm -it --entrypoint /opt/antigravity/1.4.0/bin/agy \
     -v deckhand-antigravity:/opt/antigravity:ro -v agy-sign-in:/home/node/.gemini \
     ghcr.io/bryansmee/deckhand-sandbox
   ```

   `agy` prints a sign-in address: open it, sign in with the plan's Google account, paste the
   code back, then `/quit`.

2. Write the token file it left into [the credentials folder](agents.md#the-credentials-folder) on
   the host (next to `compose.yaml`), then remove that volume:

   ```sh
   docker run --rm -v agy-sign-in:/g ghcr.io/bryansmee/deckhand-sandbox \
     cat /g/antigravity-cli/antigravity-oauth-token > credentials/agy-auth.json
   docker volume rm agy-sign-in
   ```

3. In `config.yaml`, to make it the default (or let repositories pick it, as with [Codex](codex.md)):

   ```yaml
   sandbox_agent: antigravity
   sandbox_model: best # gemini-4-argon-high; balanced and fast: gemini-4-argon-medium, gemini-3.8-flash-medium
   ```

Then restart the models service and the orchestrator. The models service logs `Antigravity CLI: a
Google AI plan's login, from /data/credentials/agy-auth.json` at start, or why it can't use it.
When the access token is within 5 minutes of its expiry, it has `agy` refresh it: the runner runs
`agy models` in a short container of the sandbox image, on a volume of its own
(`<AGY_VOLUME>-login`), outside the runs' networks (`INSTALL_NETWORK`, as the installs; on
Kubernetes, a pod of its own: [Agents on Kubernetes](../kubernetes/sandboxes.md#agents-on-kubernetes)), once
for all runs, and the models service keeps the new token in its store, sealed. When Google refuses
the refresh (the login was revoked), runs fail with "sign in with `agy` again": repeat the steps
above; the models service reads the new file without a restart. `GEMINI_API_KEY`, when set too, wins.

The egress proxy needs its CA for these runs, cache on or off (it makes it at its first
start, in its volume): a run stops when the proxy has none.
