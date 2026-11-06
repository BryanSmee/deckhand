// Machines (#594, #595): a user's own computer that takes Deckhand's tasks, through an MCP
// client of edge's /mcp (mcp.mjs) signed in as its owner with the `deckhand:machine` scope. Its
// driver registers it (a name, labels, capacity, the repositories it takes), then says it is
// there every HEARTBEAT_MS; it is online while its last heartbeat is under ONLINE_MS old.
// Settings › MCP clients lists the owner's machines, with Remove (http.mjs).
//
// A repository is offered to a machine only when both opt in (offeredLabels()): the operator's
// `machines` grant (grants.mjs GRANTS, their policies' `allow_grant`) and a `machines:` block in
// its .deckhand.yaml, whose `labels` narrow the machines it takes, never widen the grant. And
// only while the owner is in ALLOWED_USERS and may start runs there (`runs:start:work`): a
// machine never has more rights than its owner has on the dashboard.
//
// Deckhand enforces nothing on the machine itself: an agent runs there on its own, with the
// owner's files, credentials and network (WARNING). The tasks routed to a machine, its claims
// and their leases are claims.mjs's (#596).
//
// Kept in the orchestrator's store, one key per machine (`machines/<id>`, lib/store-map.mjs),
// which its two copies share.
import { randomBytes } from "node:crypto";
import { keepLast } from "../lib/capped.mjs";
import { Refused } from "../lib/http.mjs";

// How often a driver says it is there, and how long a machine stays online without it.
export const HEARTBEAT_MS = 30_000;
export const ONLINE_MS = 90_000;
// A machine's runs at once without its own config saying more, and the most it may say.
export const CAPACITY = 1;
export const MAX_CAPACITY = 16;
// Per owner, and per machine: a driver's mistake (one machine a start) can't fill the store.
export const MAX_MACHINES = 10;
export const MAX_LABELS = 20;
export const MAX_REPOS = 50;
// What offers() asks at once (a policy decision, then a .deckhand.yaml read from GitHub, per
// repository), and how long a repository's .deckhand.yaml read is used again, by offers() and
// takes() for every machine (#914): a machine taking `owner/*` on a large installation, or its
// driver registering again and again, mustn't add to GitHub's rate limit a read a repository.
// Its `machines:` block, added or removed, is seen READ_MS later at most.
export const OFFER_READS = 4;
export const READ_MS = 60_000;
const MAX_READS = 1000;
const MAX_NAME = 64;
const MAX_VERSION = 64;

// A label, in lower case: what a repository's `machines.labels` and an issue's `runs-on` name.
export const LABEL = /^[a-z0-9][a-z0-9._-]{0,49}$/;
// "owner/repo" or "owner/*", in GitHub's characters.
const REPO_PATTERN = /^[a-z0-9_.-]{1,100}\/(?:\*|[a-z0-9_.-]{1,100})$/;
const ID = /^[0-9a-f]{16}$/;
// Printable text on one line.
const LINE = /^[^\p{Cc}]+$/u;

export const WARNING =
  "An agent will run on this machine on its own, with your files, credentials and network. Deckhand suggests settings for it and enforces none: what it may do there is up to you.";

export const isMachineId = (id) => typeof id === "string" && ID.test(id);

// The issue labels that route an issue to its labeller's machines (claims.mjs): `runs-on:<label>`.
export const RUNS_ON = "runs-on:";

// The machine label a `runs-on:<label>` label of `labels` (GitHub's objects or names) asks for,
// the first in name order, with that label's own name: { label, name }, or null.
export function runsOn(labels = []) {
  const found = labels
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((name) => typeof name === "string" && name.toLowerCase().startsWith(RUNS_ON))
    .map((name) => ({ name, label: machineLabel(name.slice(RUNS_ON.length)) }))
    .filter(({ label }) => label !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
  return found[0] ?? null;
}

// Whether `issue` (as GitHub lists it) has a `runs-on` label: the auto-pickup sweep leaves it
// alone (auto-pickup.mjs), a machine task's.
export const hasRunsOn = (issue) => runsOn(issue?.labels ?? []) !== null;

// A label as kept, or null when it isn't one.
export function machineLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  return LABEL.test(label) ? label : null;
}

// Whether `repo` ("owner/name") is among `patterns` (a machine's `repos`).
export function repoMatches(patterns, repo) {
  const name = String(repo).toLowerCase();
  const owner = name.split("/")[0];
  return patterns.includes(name) || patterns.includes(`${owner}/*`);
}

// The labels a machine takes a repository's tasks with, or null when it isn't offered them:
// `granted`, whether the operator's policies grant the repository `machines`; `settings`, its
// .deckhand.yaml's (repo-config.mjs), whose `machines` is null without the block. Its `labels`
// narrow: a machine has one of them at least, and takes the tasks on those alone.
export function offeredLabels({ granted, settings, machine }) {
  if (granted !== true || !settings?.machines) return null;
  const wanted = settings.machines.labels;
  if (!wanted) return [...machine.labels];
  const labels = machine.labels.filter((l) => wanted.includes(l));
  return labels.length ? labels : null;
}

// What register_machine was given → the fields kept, or Refused (400) saying what is wrong.
export function machineFields({ name, labels = [], capacity = CAPACITY, repos, version = null }) {
  const bad = (message) => {
    throw new Refused(400, message);
  };
  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME) {
    bad(`\`name\` is text, ${MAX_NAME} characters at most.`);
  }
  if (!LINE.test(name.trim())) bad("`name` is one line of text.");
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) {
    bad(`\`labels\` is a list of ${MAX_LABELS} labels at most.`);
  }
  const kept = labels.map(machineLabel);
  const wrong = labels.find((_, i) => kept[i] === null);
  if (wrong !== undefined) {
    bad(
      `\`labels\`: ${JSON.stringify(wrong)} isn't a label (letters, digits, ".", "_" and "-", 50 at most).`,
    );
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    bad(`\`capacity\` is a whole number from 1 to ${MAX_CAPACITY}.`);
  }
  if (!Array.isArray(repos) || !repos.length || repos.length > MAX_REPOS) {
    bad(`\`repos\` lists from 1 to ${MAX_REPOS} repositories, "owner/name" or "owner/*".`);
  }
  const patterns = repos.map((r) => (typeof r === "string" ? r.trim().toLowerCase() : null));
  const wrongRepo = repos.find((_, i) => !REPO_PATTERN.test(patterns[i] ?? ""));
  if (wrongRepo !== undefined) {
    bad(`\`repos\`: ${JSON.stringify(wrongRepo)} isn't "owner/name" or "owner/*".`);
  }
  return {
    name: name.trim(),
    labels: [...new Set(kept)],
    capacity,
    repos: [...new Set(patterns)],
    version: driverVersion(version),
  };
}

function driverVersion(version) {
  if (version === null || version === undefined) return null;
  if (typeof version !== "string" || !LINE.test(version) || version.length > MAX_VERSION) {
    throw new Refused(400, `\`version\` is one line of text, ${MAX_VERSION} characters at most.`);
  }
  return version;
}

// `fn` over `items`, `limit` at once at most, its results in their order.
export async function mapLimited(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// `machines`: id → { id, owner, name, labels, capacity, repos, version, createdAt, seenAt }, the
// store's map (lib/store-map.mjs). `config.users`: ALLOWED_USERS, read at each call. The seams,
// for offers():
//   repoNames()          the installed repositories in ALLOWED_REPOS (repos.mjs names())
//   granted(repo)        whether the operator's policies grant it `machines`
//   settings(repo)       its .deckhand.yaml from its default branch: { settings, errors }, used
//                        again READ_MS (settingsOf())
//   mayRun(owner, repo)  whether `owner` may start work runs there (the access decision)
// `removed(machine)`: once a machine is removed, so that its claims end (claims.mjs).
export function createMachines({
  machines = new Map(),
  config,
  repoNames = async () => [],
  granted = async () => false,
  settings = async () => ({ settings: null, errors: ["unknown"] }),
  mayRun = async () => false,
  removed = () => {},
  now = Date.now,
  newId = () => randomBytes(8).toString("hex"),
  log = () => {},
}) {
  const allowed = (owner) => config.users.some((u) => u.toLowerCase() === owner);
  const online = (m) => allowed(m.owner) && now() - m.seenAt < ONLINE_MS;
  const owned = (owner) => [...machines.values()].filter((m) => m.owner === owner);

  // repo (lower case) → { at, read }: its .deckhand.yaml's read, a promise its callers share
  // while it runs and READ_MS after. One that throws isn't kept: the next call asks again.
  const reads = new Map();
  function settingsOf(repo) {
    const key = repo.toLowerCase();
    const kept = reads.get(key);
    if (kept && now() - kept.at < READ_MS) return kept.read;
    const read = Promise.resolve().then(() => settings(repo));
    const entry = { at: now(), read };
    keepLast(reads, key, entry, MAX_READS);
    read.catch(() => reads.get(key) === entry && reads.delete(key));
    return read;
  }

  // The owner's machine `id`, or Refused: another's is one that doesn't exist.
  function mine(owner, id) {
    const m = isMachineId(id) ? machines.get(id) : null;
    if (!m || m.owner !== owner || !allowed(owner)) {
      // Only an id's own characters go back: never arbitrary text from a path or an argument.
      const named = isMachineId(id) ? `machine ${id}` : "such machine";
      throw new Refused(404, `No ${named} of yours: register it again.`);
    }
    return m;
  }

  const view = (m) => ({
    id: m.id,
    name: m.name,
    labels: m.labels,
    capacity: m.capacity,
    repos: m.repos,
    version: m.version,
    createdAt: m.createdAt,
    seenAt: m.seenAt,
    online: online(m),
  });

  // A name already registered is that machine again (its driver restarted): its fields
  // replaced, its id kept.
  function register(owner, input) {
    if (!allowed(owner)) throw new Refused(403, "You aren't one of this Deckhand's users.");
    const fields = machineFields(input);
    const same = owned(owner).find((m) => m.name.toLowerCase() === fields.name.toLowerCase());
    if (!same && owned(owner).length >= MAX_MACHINES) {
      throw new Refused(
        409,
        `You have ${MAX_MACHINES} machines already: remove one first (Settings › MCP clients).`,
      );
    }
    const at = now();
    const m = {
      id: same?.id ?? newId(),
      owner,
      ...fields,
      createdAt: same?.createdAt ?? at,
      seenAt: at,
    };
    machines.set(m.id, m);
    log(`Machines: ${owner} ${same ? "registered again" : "registered"} ${m.name} (${m.id})`);
    return view(m);
  }

  function heartbeat(owner, id, version = null) {
    const m = mine(owner, id);
    const next = {
      ...m,
      seenAt: now(),
      ...(version !== null && { version: driverVersion(version) }),
    };
    machines.set(id, next);
    return view(next);
  }

  // Unregistered by its driver, or removed from the dashboard: its entry deleted, its claims
  // ended (`removed`), their tasks waiting again.
  function remove(owner, id) {
    const m = mine(owner, id);
    machines.delete(id);
    log(`Machines: ${owner} removed ${m.name} (${m.id})`);
    removed(m);
    return view(m);
  }

  const list = (owner) =>
    allowed(owner)
      ? owned(owner)
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map(view)
      : [];

  // The labels machine `m` takes `repo`'s tasks with now, or null when it isn't offered them: a
  // repository whose grant, config or access can't be read isn't (fail closed), the log saying
  // why.
  async function offered(m, repo) {
    try {
      if (!(await granted(repo))) return null;
      const read = await settingsOf(repo);
      if (read.errors?.length) return null;
      const labels = offeredLabels({ granted: true, settings: read.settings, machine: m });
      if (!labels || !(await mayRun(m.owner, repo))) return null;
      return labels;
    } catch (error) {
      log(`Machines: ${m.name} (${m.id}): ${repo} not offered: ${error.message ?? error}`);
      return null;
    }
  }

  // The repositories offered to the owner's machine `id` now, each with the labels it takes
  // their tasks with: [{ repo, labels }], by name. OFFER_READS repositories at once.
  async function offers(owner, id) {
    const m = mine(owner, id);
    const names = (await repoNames()).filter((repo) => repoMatches(m.repos, repo));
    const found = await mapLimited(names, OFFER_READS, async (repo) => {
      const labels = await offered(m, repo);
      return labels && { repo, labels };
    });
    return found.filter(Boolean).toSorted((a, b) => a.repo.localeCompare(b.repo));
  }

  // The labels the owner's machine `id` takes `repo`'s tasks with now (offers()'s for that
  // repository alone), or null: what a claim asks of each task it may take (claims.mjs).
  async function takes(owner, id, repo) {
    const m = mine(owner, id);
    return repoMatches(m.repos, repo) ? offered(m, repo) : null;
  }

  // The owner's machine `id` as kept, or Refused (404).
  const get = (owner, id) => ({ ...mine(owner, id) });

  // The owner's machines online now, as kept: those that may claim a task of theirs.
  const onlineOf = (owner) => (allowed(owner) ? owned(owner).filter(online) : []);

  return { register, heartbeat, remove, list, offers, takes, get, onlineOf };
}
