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
// owner's files, credentials and network (WARNING). Claims, runs and their pool are #596's.
//
// Kept in the orchestrator's store, one key per machine (`machines/<id>`, lib/store-map.mjs),
// which its two copies share.
import { randomBytes } from "node:crypto";
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

// `machines`: id → { id, owner, name, labels, capacity, repos, version, createdAt, seenAt }, the
// store's map (lib/store-map.mjs). `config.users`: ALLOWED_USERS, read at each call. The seams,
// for offers():
//   repoNames()          the installed repositories in ALLOWED_REPOS (repos.mjs names())
//   granted(repo)        whether the operator's policies grant it `machines`
//   settings(repo)       its .deckhand.yaml from its default branch: { settings, errors }
//   mayRun(owner, repo)  whether `owner` may start work runs there (the access decision)
export function createMachines({
  machines = new Map(),
  config,
  repoNames = async () => [],
  granted = async () => false,
  settings = async () => ({ settings: null, errors: ["unknown"] }),
  mayRun = async () => false,
  now = Date.now,
  newId = () => randomBytes(8).toString("hex"),
  log = () => {},
}) {
  const allowed = (owner) => config.users.some((u) => u.toLowerCase() === owner);
  const online = (m) => allowed(m.owner) && now() - m.seenAt < ONLINE_MS;
  const owned = (owner) => [...machines.values()].filter((m) => m.owner === owner);

  // The owner's machine `id`, or Refused: another's is one that doesn't exist.
  function mine(owner, id) {
    const m = isMachineId(id) ? machines.get(id) : null;
    if (!m || m.owner !== owner || !allowed(owner)) {
      throw new Refused(404, `No machine ${id} of yours: register it again.`);
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

  // Unregistered by its driver, or removed from the dashboard. Its claims end with it (#596).
  function remove(owner, id) {
    const m = mine(owner, id);
    machines.delete(id);
    log(`Machines: ${owner} removed ${m.name} (${m.id})`);
    return view(m);
  }

  const list = (owner) =>
    allowed(owner)
      ? owned(owner)
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map(view)
      : [];

  // The repositories offered to the owner's machine `id` now, each with the labels it takes
  // their tasks with: [{ repo, labels }], by name. A repository whose grant, config or access
  // can't be read isn't offered (fail closed), the log saying why.
  async function offers(owner, id) {
    const m = mine(owner, id);
    const names = (await repoNames()).filter((repo) => repoMatches(m.repos, repo));
    const offered = await Promise.all(
      names.map(async (repo) => {
        try {
          if (!(await granted(repo))) return null;
          const read = await settings(repo);
          if (read.errors?.length) return null;
          const labels = offeredLabels({ granted: true, settings: read.settings, machine: m });
          if (!labels || !(await mayRun(owner, repo))) return null;
          return { repo, labels };
        } catch (error) {
          log(`Machines: ${m.name} (${m.id}): ${repo} not offered: ${error.message ?? error}`);
          return null;
        }
      }),
    );
    return offered.filter(Boolean).toSorted((a, b) => a.repo.localeCompare(b.repo));
  }

  return { register, heartbeat, remove, list, offers };
}
