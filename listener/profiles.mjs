// Chats' permissions profiles (#478): what a chat's owner turns off of what its runs may get,
// edited as toggles in the dashboard, never as policy text. A profile only narrows: its ceiling
// is what a `chat` run of its repository gets (capabilities.mjs outcomeOf(): the policies, the
// repo's config and the operator's grant), the hosts the operator grants the repository and its
// granted mounts. Checked against that ceiling on every save (checkProfile(), which refuses what
// would widen it) and at every start (narrowProfile(), which drops silently what a grant or a
// policy no longer gives). Data only, tied to no sandbox: in one, the orchestrator narrows the
// run's capabilities, hosts and mounts with it, which the GitHub gateway, the egress proxy and the
// runner then enforce (preparation.mjs); on a user's own machine (#601), it would narrow the
// settings the driver suggests, advisory there. Format: ../docs/security.md#chats.
import { CAPABILITIES } from "./capabilities.mjs";
import { hostProblem, matchHost } from "./egress.mjs";

// The GitHub levels, least first. Read only for now (#478's decision): a chat writes nothing to
// GitHub, whatever the policies allow it.
export const LEVELS = ["read", "comment", "push"];
const LEVEL_REASON = "chats only read GitHub for now: their answers stay in the conversation";

// What a saved profile holds, each field null for everything its ceiling allows (the default):
// `capabilities`, the names kept on; `hosts`, the granted hosts kept reachable; `mounts`, the
// granted mounts kept, each { target, readOnly }.
export const DEFAULT_PROFILE = Object.freeze({
  github: "read",
  capabilities: null,
  hosts: null,
  mounts: null,
});

// Never on in a chat, whatever the policies say: `push` (no GitHub write: LEVELS), and never off:
// `pull`, a chat works in a clone of its repository (its input is its messages, not an issue's
// thread: preparation.mjs prepareBare() has nothing for it).
const NEVER = { push: LEVEL_REASON };
const REQUIRED = { pull: "a chat works in a clone of the repository" };

const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));

// What a chat's profile may hold → { capabilities, hosts, mounts, github }: `capabilities`, one
// row per catalogue entry, { name, what, needs, allowed, required, reason } (`reason`: why it is
// greyed out, or why it can't be turned off); `hosts`, the operator's for the repository (not the
// ones every run needs, which no profile turns off); `mounts`, its granted ones, { target,
// writable, reason } (`reason`: why it is read-only); `github`, one row per level, { level,
// allowed, reason }. `outcome`: capabilities.mjs outcomeOf()'s for a `chat` run; `grant`: the
// operator's (grants.mjs); `mounts`: its config's mounts as the grant resolves them
// (grants.mjs resolveMounts()). Pure.
export function ceilingOf({ outcome, grant, mounts = [] }) {
  const capabilities = outcome.capabilities.map((row) => {
    const { what, needs } = BY_NAME.get(row.name);
    const line = (allowed, reason = null, required = false) => ({
      name: row.name,
      what,
      needs,
      allowed,
      required,
      reason,
    });
    if (NEVER[row.name]) return line(false, NEVER[row.name]);
    if (!row.used) return line(false, plain(row.reason ?? row.status));
    if (REQUIRED[row.name]) return line(true, REQUIRED[row.name], true);
    return line(true);
  });
  // One whose need isn't allowed (`image:branch` with `push` never on) can't be either: its
  // toggle would never take effect. Repeated until nothing changes, as needs chain.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of capabilities.filter((c) => c.allowed)) {
      const missing = capabilities.find((c) => row.needs.includes(c.name) && !c.allowed);
      if (!missing) continue;
      Object.assign(row, {
        allowed: false,
        required: false,
        reason: `it needs ${missing.name}: ${missing.reason}`,
      });
      changed = true;
    }
  }
  // Never true while `push` is in NEVER: a chat's mounts are all read-only, the reason alone
  // saying whether the grant or the chat makes them so. Kept so that a chat level that pushes
  // (LEVELS) needs no change here.
  const push = capabilities.some((c) => c.name === "push" && c.allowed);
  return {
    capabilities,
    hosts: [...new Set((grant?.hosts ?? []).map((h) => h.toLowerCase()))],
    mounts: mounts.map((m) => ({
      target: m.target,
      writable: !m.readOnly && push,
      reason: m.readOnly
        ? "the operator grants it read-only"
        : push
          ? null
          : "a chat doesn't push: its mounts are read-only",
    })),
    github: LEVELS.map((level) => ({
      level,
      allowed: level === "read",
      reason: level === "read" ? null : LEVEL_REASON,
    })),
  };
}

// A profile sent to be saved (POST /api/chats/<id>/permissions), checked against `ceiling`
// (ceilingOf()'s) → { profile, errors }: `profile`, normalized (each list in the ceiling's
// order, each name once), null with errors. Everything it names must be within the ceiling: a
// host the operator doesn't grant, a capability the policies, the config or the grants don't give,
// a read-write mount the grant mounts read-only or a GitHub level above read is an error, never
// dropped quietly: the user sees what they asked for refused.
export function checkProfile(body, ceiling) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { profile: null, errors: ["a profile is an object"] };
  }
  for (const key of Object.keys(body)) {
    if (!(key in DEFAULT_PROFILE)) errors.push(`\`${key}\`: not part of a profile`);
  }
  const github = body.github ?? DEFAULT_PROFILE.github;
  const level = ceiling.github.find((l) => l.level === github);
  if (!level) errors.push(`GitHub: \`${github}\` isn't a level (${LEVELS.join(", ")})`);
  else if (!level.allowed) errors.push(`GitHub: \`${github}\`: ${level.reason}`);

  const capabilities = listOf(body.capabilities, "capabilities", errors, (name) => {
    if (typeof name !== "string") return "not a name";
    const row = ceiling.capabilities.find((c) => c.name === name);
    if (!row) return "not a capability Deckhand knows";
    return row.allowed ? null : row.reason;
  });
  if (capabilities) {
    for (const row of ceiling.capabilities) {
      if (row.required && !capabilities.includes(row.name)) {
        errors.push(`\`${row.name}\` can't be turned off: ${row.reason}`);
      }
    }
    for (const name of capabilities) {
      for (const need of BY_NAME.get(name)?.needs ?? []) {
        if (!capabilities.includes(need)) errors.push(`\`${name}\` needs \`${need}\``);
      }
    }
  }

  const hosts = listOf(body.hosts, "hosts", errors, (host) => {
    if (typeof host !== "string") return "not a host";
    return ceiling.hosts.includes(host.toLowerCase())
      ? null
      : "not among the hosts the operator grants this repository";
  });

  const mounts = listOf(
    body.mounts,
    "mounts",
    errors,
    (m) => {
      if (!m || typeof m.target !== "string" || typeof (m.readOnly ?? true) !== "boolean") {
        return "a mount is { target, readOnly }";
      }
      const granted = ceiling.mounts.find((g) => g.target === m.target);
      if (!granted) return "not among the repository's granted mounts";
      if (m.readOnly === false && !granted.writable) return `read-write: ${granted.reason}`;
      return null;
    },
    (m) => m?.target ?? String(m),
  );

  if (errors.length) return { profile: null, errors };
  const inOrder = (list, all, key = (x) => x) =>
    list && all.filter((x) => list.some((y) => key(y) === key(x)));
  return {
    profile: {
      github,
      capabilities: inOrder(
        capabilities,
        ceiling.capabilities.map((c) => c.name),
      ),
      hosts:
        hosts &&
        inOrder(
          hosts.map((h) => h.toLowerCase()),
          ceiling.hosts,
        ),
      mounts:
        mounts &&
        inOrder(mounts, ceiling.mounts, (m) => m.target).map((g) => ({
          target: g.target,
          readOnly: mounts.find((m) => m.target === g.target).readOnly !== false,
        })),
    },
    errors: [],
  };
}

// `value`: null (everything), or an array whose items `problem(item)` checks (null: fine, else
// why not). → the array, or null; what is wrong in `errors`, by `label(item)`.
function listOf(value, field, errors, problem, label = (item) => String(item)) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    errors.push(`\`${field}\`: a list, or null for everything allowed`);
    return null;
  }
  for (const item of value) {
    const why = problem(item);
    if (why) errors.push(`\`${label(item)}\`: ${why}`);
  }
  return value;
}

// What a chat's run gets of `profile` (a saved one, or null for the default) within `ceiling`
// (ceilingOf()'s, as the run starts) → { github, capabilities, hosts, mounts }, each concrete:
// what the ceiling no longer allows is dropped (a grant removed since the save narrows it
// silently), the required ones kept, and a capability whose need is off dropped too. A mount
// is read-only unless both the profile and the ceiling say otherwise. Pure.
export function narrowProfile(profile, ceiling) {
  const saved = { ...DEFAULT_PROFILE, ...profile };
  const allowed = ceiling.capabilities.filter((c) => c.allowed);
  let capabilities = allowed
    .filter((c) => c.required || saved.capabilities === null || saved.capabilities.includes(c.name))
    .map((c) => c.name);
  // A need gone takes what needs it along (`image:branch` goes with `push`…), until none is left.
  for (let changed = true; changed;) {
    const kept = capabilities.filter((name) =>
      BY_NAME.get(name).needs.every((need) => capabilities.includes(need)),
    );
    changed = kept.length !== capabilities.length;
    capabilities = kept;
  }
  const hosts = ceiling.hosts.filter((h) => saved.hosts === null || saved.hosts.includes(h));
  const mounts = ceiling.mounts
    .map((g) => ({ granted: g, saved: saved.mounts?.find((m) => m.target === g.target) }))
    .filter(({ saved: m }) => saved.mounts === null || m)
    .map(({ granted, saved: m }) => ({
      target: granted.target,
      readOnly: !granted.writable || m?.readOnly !== false,
    }));
  const github = ceiling.github.find((l) => l.level === saved.github && l.allowed)
    ? saved.github
    : "read";
  return { github, capabilities, hosts, mounts };
}

// What a profile leaves out of what the ceiling gives, for the run's log: "docker, read:issues;
// hosts: npmjs.org; mounts: /srv/data", or null when it leaves nothing out.
export function leftOut(effective, ceiling) {
  const caps = ceiling.capabilities
    .filter((c) => c.allowed && !effective.capabilities.includes(c.name))
    .map((c) => c.name);
  const hosts = ceiling.hosts.filter((h) => !effective.hosts.includes(h));
  const mounts = ceiling.mounts
    .map((m) => m.target)
    .filter((t) => !effective.mounts.some((m) => m.target === t));
  const parts = [
    caps.length && caps.join(", "),
    hosts.length && `hosts: ${hosts.join(", ")}`,
    mounts.length && `mounts: ${mounts.join(", ")}`,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

// The outcome's reasons are Markdown (`setup`…): the dashboard shows them as text.
const plain = (text) => String(text).replaceAll("`", "");

// --- Requests for more (#479, requests.mjs) ------------------------------------------------

// What a chat's agent may ask for (../sandbox/deckhand-permissions): a host, a GitHub level, the
// container engine or one of the repository's granted mounts.
export const REQUEST_KINDS = ["host", "github", "engine", "mount"];

// What the operator alone can change, for the agent to say: beyond the ceiling, a request is
// refused without asking the chat's owner (#479's decision), who couldn't approve it anyway.
const OPERATOR = "Only Deckhand's operator can change that, in their grants folder";

// A request `{ kind, value }` of a chat's run, against `ceiling` (ceilingOf()'s, now), the chat's
// saved `profile` (null for the default) and what its sandbox has (`live`: { hosts, mounts,
// engine }, as its start gave it them, its approved hosts since) →
//   { verdict: "invalid" | "beyond", message }  refused at once, `message` for the agent;
//   { verdict: "given", message }                its sandbox has it already;
//   { verdict: "saved", what, adds, live }       its profile has it, its sandbox not (a profile
//                                                changed since it started): no question asked;
//   { verdict: "ask", what, adds, live }         for its owner to answer.
// `what`: how the request is named to them; `adds`: what an approval adds to a profile
// ({ hosts } of the ceiling's entries, { capabilities }, { mounts }: widened()); `live`: whether
// it applies to the sandbox going (a host: the egress proxy reads the run's hosts on each
// connection) rather than at its next start. Pure.
export function requestVerdict({ kind, value }, { ceiling, profile, live }) {
  const saved = { ...DEFAULT_PROFILE, ...profile };
  const text = typeof value === "string" ? value.trim() : "";
  if (kind === "host") {
    const host = text.toLowerCase().replace(/\.$/, "");
    if (!host || host === "*" || hostProblem(host)) {
      return invalid("a host is a name such as registry.npmjs.org");
    }
    if (live.hosts && matchHost(host, live.hosts) !== null) {
      return given(`${host} is reachable from this sandbox already`);
    }
    const entry =
      ceiling.hosts.find((h) => h === host) ??
      ceiling.hosts.find((h) => matchHost(host, [h]) !== null);
    if (!entry) {
      return beyond(`${host} isn't among the hosts the operator grants this repository`, "hosts");
    }
    const what = entry === host ? host : `${host} (granted as ${entry})`;
    const adds = { hosts: [entry] };
    const has = saved.hosts === null || saved.hosts.includes(entry);
    return { verdict: has ? "saved" : "ask", what, adds, live: true };
  }
  if (kind === "github") {
    const level = ceiling.github.find((l) => l.level === text);
    if (!level) return invalid(`a GitHub level is one of ${LEVELS.join(", ")}`);
    if (!level.allowed) return beyond(`GitHub ${text}: ${level.reason}`);
    return given("this sandbox reads GitHub already");
  }
  if (kind === "engine") {
    const row = ceiling.capabilities.find((c) => c.name === "docker");
    if (!row?.allowed) return beyond(`the container engine: ${row?.reason ?? "not offered"}`);
    if (live.engine) return given("this sandbox has a container engine already");
    const adds = { capabilities: withNeeds("docker", ceiling) };
    const has =
      saved.capabilities === null || adds.capabilities.every((c) => saved.capabilities.includes(c));
    return { verdict: has ? "saved" : "ask", what: "a container engine", adds, live: false };
  }
  if (kind === "mount") {
    const target = text.replace(/(?<=.)\/+$/, "");
    if (!target.startsWith("/")) return invalid("a mount is the absolute path it is mounted at");
    const row = ceiling.mounts.find((m) => m.target === target);
    if (!row) {
      return beyond(
        `${target} isn't among the repository's granted mounts (its .deckhand.yaml asks for them, the operator grants them)`,
        "mounts",
      );
    }
    if ((live.mounts ?? []).includes(target)) return given(`${target} is mounted already`);
    const adds = { mounts: [{ target, readOnly: true }] };
    const has = saved.mounts === null || saved.mounts.some((m) => m.target === target);
    return { verdict: has ? "saved" : "ask", what: `${target} (read-only)`, adds, live: false };
  }
  return invalid(`a request's kind is one of ${REQUEST_KINDS.join(", ")}`);
}

const invalid = (why) => ({ verdict: "invalid", message: `Refused: ${why}.` });
const given = (why) => ({ verdict: "given", message: `Granted: ${why}.` });
// `key`: the grants file's key that would give it, said to the agent.
const beyond = (why, key = null) => ({
  verdict: "beyond",
  message: `Refused: ${why}. ${OPERATOR}${key ? ` (\`${key}\`)` : ""}: tell the user if it matters, and carry on without it.`,
});

// `name` and the capabilities it needs, that the ceiling allows, in the catalogue's order.
function withNeeds(name, ceiling) {
  const all = new Set([name]);
  // A Set iterates over what is added meanwhile: needs' needs too.
  for (const n of all) for (const need of BY_NAME.get(n)?.needs ?? []) all.add(need);
  return ceiling.capabilities.filter((c) => all.has(c.name) && c.allowed).map((c) => c.name);
}

// `profile` with `adds` (requestVerdict()'s) in it: a list grows, null (everything the ceiling
// allows) stays null. Pure; checkProfile() holds the result to the ceiling.
export function widened(profile, adds) {
  const saved = { ...DEFAULT_PROFILE, ...profile };
  const out = { ...saved };
  if (adds?.capabilities && saved.capabilities) {
    out.capabilities = [...new Set([...saved.capabilities, ...adds.capabilities])];
  }
  if (adds?.hosts && saved.hosts) out.hosts = [...new Set([...saved.hosts, ...adds.hosts])];
  if (adds?.mounts && saved.mounts) {
    const kept = saved.mounts.filter((m) => !adds.mounts.some((a) => a.target === m.target));
    out.mounts = [...kept, ...adds.mounts];
  }
  return out;
}
