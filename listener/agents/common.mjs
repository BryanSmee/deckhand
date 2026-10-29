// What the agents (claude.mjs, codex.mjs, antigravity.mjs) write the same way. Apart from index.mjs, which
// imports the agents: they would read these before index.mjs had defined them.

// Deckhand's efforts, which both agents name the same.
export const EFFORTS = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

// How an agent is installed: per version into a shared, root-owned volume
// (images.installAgent()), mounted read-only in sandboxes at /opt/<package>, by the base
// image's deckhand-install-<package> (../../sandbox/agents/<agent>/install). `env`: more of
// its variables (a pinned digest).
export function installSpec(pkg, { volume, version, versionVar, env }) {
  return {
    volume,
    mount: `/opt/${pkg}`,
    version,
    versionVar,
    command: `deckhand-install-${pkg}`,
    ...(env && { env }),
  };
}

// A tool call's or output's `id`, which pairs them in the dashboard, when the agent gives one:
// a call with one has an output to come (a call without one may have none).
export const idOf = (id) => (typeof id === "string" && id ? { id } : {});

// An agent's normalize(): one line of its output → Deckhand's events, by the line's JSON
// `type` (`events`: type → (event) → events), or the field `key` names. Lines that aren't its
// JSON, or of other types, give none.
export function normalizer(events, key = "type") {
  return (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return [];
    }
    return e && Object.hasOwn(events, e[key]) ? events[e[key]](e) : [];
  };
}
