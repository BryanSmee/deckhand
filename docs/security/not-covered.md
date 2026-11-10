# Not covered

What Deckhand doesn't check, or accepts, across every area. Part of the [Security overview](../security.md).

- **A Podman engine** exposes much more of the host's kernel than a sandbox does: seccomp
  and AppArmor are off, so every system call (`keyctl`, `bpf` where unprivileged use is
  allowed, `userfaultfd`…) and mount is open to code running in it, as are `/dev/fuse` and
  `/dev/net/tun`. A kernel bug reachable that way is a way out of the container. Prefer
  Sysbox, and grant `docker` only to repositories whose default branch you trust.
- **An engine's containers** run what the run builds, with the run's hosts: a repository's
  Dockerfile pulling from a host the run may reach can bring anything in, as its setup
  command can.
- **A fork's code in a work run** can still write to the agent's session (`~/.claude`,
  `~/.codex` or `~/.gemini`) of that run's issue, which its next work run starts with. What
  `.git` keeps besides hooks (objects, refs, the stash, and the branches' `remote` and
  `merge`), enough to make a branch of its own look like one of the repository's, stays in a
  fork's run's own clone (`-fork-workspace`), which only the issue's later fork's runs start
  from. It can also push the run's own branch, its pull request's commits included, which a
  repository granted `branch_docker_images` builds and the issue's later work runs
  fetch as the repository's own. It ran with the same token
  and hosts as the run it would reach, one an allowed user asked for: read what a fork's pull
  request does before asking for work on it (see [What a fork's code may reach](forks.md#what-a-forks-code-may-reach)).
- **A fork's pull request only mentioned** (in an issue, or a comment from elsewhere: "check
  out #7 and fix it") isn't seen as a fork's run: the run gets the repository's caches,
  read-write mounts and engine, and the GitHub gateway refuses it the fork's code ([What a
  fork's code may reach](forks.md#what-a-forks-code-may-reach)). Not everything goes through the
  gateway, though: the run's container engine reaches GitHub anonymously, around it (the
  exception in [The GitHub gateway](github.md#the-github-gateway)), so a build there can fetch a
  public fork; a `codeload.github.com` grant serves any public repository's archives; and the
  same code anywhere else (another repository, a gist, a package registry the run may reach;
  a granted host whose name leads to GitHub's content CDN, or another of GitHub's own hosts
  granted (`codeload.github.com`, `*.github.com`), whose front ends may answer for one another
  as the content CDN does: a tunnel to either would reach them unchecked; a granted host that
  fetches from GitHub for the sandbox by the repository's own name, as the Go module proxy
  does for `go get github.com/<owner>/<repo>@<sha>` or jsDelivr for `/gh/<owner>/<repo>@<sha>/`:
  GitHub serves a fork's commit through the repository's name, so such a host likely does
  too),
  or written as text (a pull request's description, a comment, a workflow's check-run
  summary), is no fork's tree to any check. Ask for work on a fork's pull request from that
  pull request.
- **Image builds** (a repo's `dockerfile`, with the `dockerfile` grant) and the **Claude Code
  install** run with normal network access: they run on the host's Docker, outside the
  sandboxes' networks. Builds run the repo's Dockerfile from its default branch (or its pull
  requests' branches with `branch_docker_images`). A branch's image gets a tag of its
  own (`branch-…`, hashing its commit), so the default branch's runs never use an image built
  from a branch. A repo's image name and tags hash the repository too
  (`<prefix>-repo-<owner>-<repo>-<hash>`): repositories whose names read alike (`acme/x.y`,
  `acme/x-y`) never run, or prune, each other's image.
- **Deckhand's own source** is in every sandbox, read-only (`/usr/local/share/deckhand/src`,
  for onboarding: see [Onboarding](../contributing/runs.md#onboarding)), repo images built from the
  base image included: whoever can steer a run can read it. In a one-operator deployment
  those are the operator's own repositories and users, so it is accepted: Deckhand's source is
  public anyway. It holds no secret: those are in the operator's settings and grants folder,
  never in the image. An image built from an operator's own
  checkout copies these folders as they are on disk: `.dockerignore` leaves out `.env`,
  `*.pem` and `*.key` files anywhere, but nothing else that isn't tracked.
- **DNS**: Docker's embedded resolver may forward lookups from the internal network to the
  host's resolvers, so a lookup of a made-up name could carry data out to that domain's DNS
  server.
- **The proxy is on every run's network**: a sandbox reaches the proxy's port, as every
  other sandbox does, but not the other sandboxes behind it. With metrics on for it
  (`EGRESS_METRICS_PORT` with Compose, its own setting and off by default,
  [Metrics](../guides/metrics.md)), a sandbox reaches that port too: `GET /metrics` alone, nothing
  secret, but what it counts is every run's together: its memory, CPU and event loop lag, and
  its connections, denials, bytes and cache requests (by source and reason, never a host or a
  run) move with other runs' traffic. The other services' metrics ports are on no run's network.
- **Allowed hosts are trusted entirely**: anything a sandbox can write to on one is a way
  out: its own repository on GitHub, a bucket or paste service behind `*`.
- **A research run allows every public host**: everything it holds can leave, so it holds
  little (see [Research runs](policies.md#research-runs)), but what it does hold can: the issue's
  thread, what it read on the web, and what the agent's provider sends back. Don't grant
  `research` to a repository whose issues hold what must not leave.
- Edge's port (8080: dashboard, webhook) is on no run's network, but a sandbox may reach its
  published address through the proxy, as any host its run may reach; it needs a dashboard
  session (a signed-in allowed user, see [The dashboard](../guides/dashboard.md#signing-in)) or the webhook's
  signature. `/status` also answers calls from inside edge's container that prove it with a
  token from edge's session key (see
  [The dashboard](webhooks-and-sign-in.md#the-dashboard)).
  Deliveries without a signature or over 5 MB are refused before their body is read (a push
  that large only delays a config's refresh). At most 16 are read at once, 4 per client
  address (per /64 for IPv6), each within 10 seconds and dropped after 2 seconds without
  data. A reader older than a second loses its place to a new delivery when its address's
  share, or edge, is full: GitHub sends a body in milliseconds. When edge is
  full of younger readers, a delivery from an address holding fewer places than another takes
  the oldest place of the address holding the most, so a few clients reopening stalled bodies
  can delay deliveries but not keep them out. Behind a reverse proxy every delivery has the
  proxy's address, so they all share those 4 places: restrict `/webhook` to GitHub's `hooks`
  ranges (`https://api.github.com/meta`) at the proxy, and let it buffer request bodies, to
  keep slow clients away from edge.
