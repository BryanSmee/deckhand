# Contributing to Deckhand

Thanks for looking. Deckhand is maintained by one person and mostly built by itself: read this
before you spend time on a pull request.

## How work happens

- **Issues first.** Every change starts from a GitHub issue that says what and why: a bug
  report, or an idea discussed until its open questions are answered. Open one before a pull
  request that changes behaviour, so the design is settled before the code.
- **Most pull requests come from Deckhand's own runs.** The maintainer starts a run on an
  issue; it works on the issue's branch (`issue-<n>-<slug>`), opens a draft pull request
  (`Closes #<n>`), and marks it ready when the checks pass. A review run then reads it, and the
  maintainer reviews and merges it. A pull request from a person goes through the same review
  and the same rules.
- **Pull requests from forks**: their checks may wait for the maintainer's approval, and
  Deckhand's runs never build, install or run a fork's code (docs/security.md, [What a fork's
  code may reach](docs/security.md#what-a-forks-code-may-reach)). A maintainer may take the
  work over on an issue's branch instead.
- **Security issues** are never reported in public: see [SECURITY.md](SECURITY.md).

One branch and one pull request per issue, in English, never pushed to `main`. The
conventions (no runtime dependencies, ESM, comments that explain why, nothing
project-specific), the security rules a change must not weaken, and the testing rules are in
[AGENTS.md](AGENTS.md): they apply to people as much as to agents.

## Checks

Node 26. Run these before pushing; CI runs them on every pull request
(`.github/workflows/checks.yml`):

```sh
# Tests, after bundling graphql-js (the GitHub gateway's one dependency)
(cd listener/vendor && npm ci && npm run build)
node --test --test-force-exit --import ./test/blocking-stdout.mjs --test-timeout=120000

# The dashboard, when it changed: types, tests, build
(cd dashboard && npm ci && npm test && npm run build)

# The docs site, when docs/ changed: its build, then every page's anchors as the site renders them
(cd docs && npm ci && npm run build)
node --test test/docs-links.test.mjs

# Format (--write to fix)
npx --yes prettier@3 --check .
```

The syntax checks (`node --check` on every service's entry point, `bash -n` on each sandbox
script) list many files: copy them from [AGENTS.md's Commands](AGENTS.md#commands), which
stays up to date. The suite passes as root and as any other user, and the pure-Node tests on
Windows too ([AGENTS.md, Testing](AGENTS.md#testing)). Flaky is a bug: fix it at its cause,
never retry it away.

`cd dashboard && npm run dev` serves the dashboard against an edge on port 8080. `cd docs && npm run dev` previews the docs site.

## Runs in flight

An update never waits for the runs: sandboxes keep running under the new services, a new run
may start on an older sandbox image, and the next orchestrator picks up the runs the last one
left. So a change to the contract between the services and the sandbox (the variables a run
starts with, the endpoints a sandbox calls, the egress proxy's answers, a run's state in the
store, the token's claims, the sandbox's scripts) must say how it doesn't break them:

- check the three cases: running sandboxes under the new services, new runs on an older
  sandbox image, and runs the next orchestrator picks up;
- say so in the pull request, under a "Runs in flight" heading: "None affected", or which runs
  break and how they fail;
- when runs break, pick one way out: a compatibility shim on the services' side, a fallback
  in the sandbox's scripts, a check that fails the run at once with what to run, or a one-time
  recovery written in the pull request for the operator;
- never fail silently: a run that can't work stops at its start, saying why.

The details: [AGENTS.md, Runs in flight](AGENTS.md#runs-in-flight) and
[docs/architecture.md, Runs in flight](docs/architecture.md#runs-in-flight).

## Licence

Contributions are under the [Apache License 2.0](LICENSE), like the rest of the repository.
