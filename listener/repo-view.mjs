// What a repo's runs get, for the dashboard's config panel: its .deckhand.yaml's settings
// against the operator's, each value tagged "repo", "operator", "refused", or "unknown" when
// it needs a grant and the operator's grants have errors. Built from the same checks a run
// makes (grantFor, operatorHosts, resolveMounts, customMode) so the panel can't say
// something a run wouldn't do.
import { realpathSync, statSync } from "node:fs";
import { mandatoryHosts } from "./egress.mjs";
import { grantFor, grantsFrom, resolveMounts, ungranted } from "./grants.mjs";
import { defaultSettings, KEYS } from "./repo-config.mjs";

// The runs' reasons are Markdown for GitHub replies; the panel shows text.
const plain = (text) => text.replaceAll("`", "");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function limitsText({ cpus, memory, pids }) {
  return `${cpus} CPUs, ${memory} memory, ${pids} processes`;
}

// Why a grant-gated value is neither granted nor refused.
const UNKNOWN = "depends on the operator's grants, which have errors";

// The settings a run reads, as rows of the panel's table, one key of the file after the other
// (KEYS' `display`). What the repo asks for that only a grant allows (ungranted()) is refused:
// it stops every run. `known`: false when `grant` is a stand-in for grants that have errors, so
// what it lacks is unknown rather than refused.
function settingRows(config, settings, grant, known = true) {
  const base = defaultSettings(config);
  const missing = ungranted(grant, settings);
  const rows = Object.entries(KEYS).flatMap(([key, { field, display }]) => {
    if (!display) return [];
    // From the repo when its file changed the operator's value.
    const changed = !!field && !same(settings[field], base[field]);
    const unknown = (value) => ({ key, value, source: "unknown", note: UNKNOWN });
    const refused = (value) => {
      const why = missing.find((m) => m.startsWith(`${key}: `));
      if (!why) return null;
      if (!known) return unknown(value);
      return { key, value, source: "refused", note: plain(why.slice(key.length + 2)) };
    };
    const row = (value, note = null) => ({
      key,
      value,
      source: changed ? "repo" : "operator",
      note,
    });
    const value = field ? settings[field] : undefined;
    return display({ key, value, changed, config, settings, grant, known, row, refused, unknown });
  });
  const limits = {
    key: "limits",
    value: limitsText(grant.limits),
    source: "operator",
    note: grant.limitsFile ? `grants/${grant.limitsFile}` : "built in",
  };
  return [...rows, limits];
}

// Every host its sandboxes may reach, each with the file that grants it: the operator's grants
// folder is the only place hosts are listed (operatorHosts()).
function hostRows(config, grant) {
  const rows = [];
  const seen = new Set();
  const add = (host, note) => {
    if (seen.has(host)) return;
    seen.add(host);
    rows.push({ host, source: "operator", note });
  };
  for (const host of mandatoryHosts(config)) add(host, "always");
  for (const host of grant.hosts) add(host, `grants/${grant.hostFiles[host]}`);
  return rows;
}

// The repo's mount requests, each resolved as a run resolves it (a refused one stops runs).
// `grant`: null when the grants have errors, so no mount root is known.
function mountRows(settings, grant, fs = {}) {
  return settings.mounts.map((request) => {
    if (!grant) {
      return { path: request.path, source: "unknown", readOnly: request.readOnly, note: UNKNOWN };
    }
    const { mounts, refused, notes } = resolveMounts([request], grant, {
      caches: settings.caches,
      ...fs,
    });
    if (refused.length) {
      const why = plain(refused[0].replace(/^`[^`]*`: /, ""));
      return { path: request.path, source: "refused", readOnly: request.readOnly, note: why };
    }
    const [m] = mounts;
    return {
      path: m.target,
      source: "repo",
      readOnly: m.readOnly,
      note:
        [m.source !== m.target ? `from ${m.source}` : null, ...notes].filter(Boolean).join("; ") ||
        null,
    };
  });
}

// What the operator grants the repo, as the panel shows it, with the files it comes from.
function grantRows(grant) {
  return {
    files: grant.files,
    allowPreview: grant.allowPreview,
    allowDockerfile: grant.allowDockerfile,
    allowBranchDockerImages: grant.allowBranchDockerImages,
    allowDocker: grant.allowDocker,
    allowResearch: grant.allowResearch,
    allowWorkflows: grant.allowWorkflows,
    hosts: grant.hosts,
    cachedHosts: grant.cachedHosts,
    mounts: grant.mounts.map(({ root, readOnly }) => ({ root, readOnly })),
    limits: grant.limits,
  };
}

// Everything the panel shows under the file's errors and warnings. `grant`: grantFor()'s, or
// null when the repo's grants have errors (no run starts then; the defaults are shown, and what
// needs a grant is "unknown", not refused: the grants file's error is the one to fix).
export function effectiveView(
  config,
  repo,
  settings,
  grant,
  fs = { realpath: realpathSync, stat: statSync },
) {
  const shown = grant ?? grantFor(grantsFrom({}, config), config, repo);
  return {
    settings: settingRows(config, settings, shown, !!grant),
    hosts: hostRows(config, shown),
    mounts: mountRows(settings, grant, fs),
    grant: grant ? grantRows(grant) : null,
  };
}
