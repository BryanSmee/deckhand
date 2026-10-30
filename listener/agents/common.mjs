// What the agents (claude.mjs, codex.mjs, antigravity.mjs) write the same way. Apart from index.mjs, which
// imports the agents: they would read these before index.mjs had defined them.

// Deckhand's efforts, which both agents name the same.
export const EFFORTS = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

// How an agent is installed: per version into a shared, root-owned volume
// (images.installAgent()), mounted read-only in sandboxes at /opt/<package>, by the base
// image's deckhand-install-<package> (../../sandbox/agents/<agent>/install). `env`: more of
// its variables (a pinned digest); `hosts`: what it downloads from (npm's registry, unless
// it says otherwise).
const NPM = ["registry.npmjs.org"];

export function installSpec(pkg, { volume, version, versionVar, env, hosts = NPM }) {
  return {
    volume,
    mount: `/opt/${pkg}`,
    version,
    versionVar,
    command: `deckhand-install-${pkg}`,
    // What the install reaches, through the egress proxy where it goes through it (the
    // Kubernetes runner's installs, runner/kube-images.mjs).
    hosts,
    ...(env && { env }),
  };
}

// A tool call's or output's `id`, which pairs them in the dashboard, when the agent gives one:
// a call with one has an output to come (a call without one may have none).
export const idOf = (id) => (typeof id === "string" && id ? { id } : {});

// The output a cut line held, as its call's: `pattern` finds its id near the line's start,
// before the output itself (which may quote any id). Its text: the line as it was kept.
export function cutOutput(pattern) {
  return (line) => {
    const id = pattern.exec(line.slice(0, 300))?.[1];
    return id ? [{ type: "toolOutput", error: false, text: line, id }] : [];
  };
}

// An agent's normalize(): one line of its output → Deckhand's events, by the line's JSON
// `type` (`events`: type → (event) → events), or the field `key` names. Lines that aren't its
// JSON, or of other types, give none, but for `cut(line)`'s: a line that follow() cut at
// MAX_LINE no longer parses, and may still say whose output it was (cutOutput()).
export function normalizer(events, key = "type", cut = () => []) {
  return (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return cut(line);
    }
    return e && Object.hasOwn(events, e[key]) ? events[e[key]](e) : [];
  };
}
