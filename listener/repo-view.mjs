// What a repo's runs get, for the dashboard's config panel: its .deckhand.yaml's settings
// against the operator's, each value tagged "repo", "operator" or "refused". Built from the
// same checks a run makes (grantFor, operatorHosts, resolveMounts, customMode) so the
// panel can't say something a run wouldn't do.
import { realpathSync, statSync } from "node:fs";
import { mandatoryHosts } from "./egress.mjs";
import { grantFor, grantsFrom, resolveMounts, ungranted } from "./grants.mjs";
import { customMode, defaultSettings } from "./repo-config.mjs";

const none = (values) => (values.length ? values.join(", ") : "none");

// The runs' reasons are Markdown for GitHub replies; the panel shows text.
const plain = (text) => text.replaceAll("`", "");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One row: from the repo when its file changed the operator's value.
function row(key, value, repoSet, note = null) {
  return { key, value, source: repoSet ? "repo" : "operator", note };
}

function limitsText({ cpus, memory, pids }) {
  return `${cpus} CPUs, ${memory} memory, ${pids} processes`;
}

// The settings a run reads, as rows of the panel's table. What the repo asks for that only a
// grant allows (ungranted()) is refused: it stops every run.
export function settingRows(config, settings, grant) {
  const base = defaultSettings(config);
  const changed = (field) => !same(settings[field], base[field]);
  const missing = ungranted(grant, settings);
  const refusedRow = (key, value) => {
    const why = missing.find((m) => m.startsWith(`${key}: `));
    return why && { key, value, source: "refused", note: plain(why.slice(key.length + 2)) };
  };
  const rows = [
    row(
      "users",
      none(settings.users),
      changed("users"),
      changed("users") ? `narrowed from ALLOWED_USERS (${none(config.users)})` : null,
    ),
    row("trigger", settings.trigger, changed("trigger")),
    row("model", settings.model, changed("model")),
    row("effort", settings.effort, changed("effort")),
    row("brainstorm_model", settings.brainstormModel, changed("brainstormModel")),
    row("brainstorm_effort", settings.brainstormEffort, changed("brainstormEffort")),
    row(
      "max_parallel",
      String(settings.maxParallel),
      changed("maxParallel"),
      changed("maxParallel") ? `MAX_PARALLEL is ${config.maxParallel}` : null,
    ),
    row("setup", settings.setup ?? "none", changed("setup")),
    row("instructions", settings.instructions ?? "none", changed("instructions")),
    refusedRow("dockerfile", settings.dockerfile) ??
      row(
        "dockerfile",
        settings.dockerfile ?? `none: the base image ${config.image}`,
        changed("dockerfile"),
      ),
    row(
      "allow_branch_docker_images",
      String(grant.allowBranchDockerImages && !!settings.dockerfile),
      false,
      grant.allowBranchDockerImages && !settings.dockerfile
        ? "granted, but the repository has no dockerfile"
        : "the operator's grants",
    ),
    refusedRow("docker", dockerText(settings.docker)) ??
      row(
        "docker",
        dockerText(settings.docker),
        changed("docker"),
        settings.docker && !config.engine ? "the operator hasn't set SANDBOX_ENGINE" : null,
      ),
    row("caches", none(settings.caches), changed("caches")),
    row("inbox", inboxText(settings.inbox), changed("inbox")),
    refusedRow("preview", previewText(settings.preview)) ??
      row("preview", previewText(settings.preview), changed("preview")),
    row(
      "conflicts",
      settings.conflicts ? `every ${settings.conflicts.checkMinutes} minutes` : "off",
      changed("conflicts"),
      config.conflictCheckMinutes ? null : "the operator turned the conflict watcher off",
    ),
  ];
  for (const name of Object.keys(settings.modes)) {
    const mode = customMode(settings, name);
    const traits = [
      mode.instructions,
      `${mode.model}/${mode.effort}`,
      mode.light ? "light" : null,
      mode.fresh ? "fresh session" : null,
    ];
    rows.push(row(`modes.${name}`, traits.filter(Boolean).join(" · "), true));
  }
  rows.push(
    row(
      "limits",
      limitsText(grant.limits),
      false,
      grant.limitsFile ? `grants/${grant.limitsFile}` : "built in",
    ),
  );
  return rows;
}

function inboxText(inbox) {
  const parts = [];
  if (inbox.ideas) parts.push(`ideas #${inbox.ideas}`);
  if (inbox.bugs) parts.push(`bugs #${inbox.bugs}`);
  if (inbox.discussions) parts.push(`discussions "${inbox.discussions}"`);
  return none(parts);
}

function dockerText(docker) {
  if (!docker) return "none";
  return docker.cache ? "a container engine, its cache kept" : "a container engine";
}

function previewText(preview) {
  if (!preview) return "none";
  const image = preview.image ? `, image ${preview.image}` : "";
  return `${preview.command} (${preview.timeoutMinutes} min${image})`;
}

// Every host its sandboxes may reach, each with the file that grants it: the operator's grants
// folder is the only place hosts are listed (operatorHosts()).
export function hostRows(config, grant) {
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
export function mountRows(settings, grant, fs = {}) {
  return settings.mounts.map((request) => {
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
export function grantRows(grant) {
  return {
    files: grant.files,
    allowPreview: grant.allowPreview,
    allowDockerfile: grant.allowDockerfile,
    allowBranchDockerImages: grant.allowBranchDockerImages,
    allowDocker: grant.allowDocker,
    hosts: grant.hosts,
    mounts: grant.mounts.map(({ root, readOnly }) => ({ root, readOnly })),
    limits: grant.limits,
  };
}

// Everything the panel shows under the file's errors and warnings. `grant`: grantFor()'s, or
// null when the repo's grants have errors (no run starts then; the defaults are shown).
export function effectiveView(
  config,
  repo,
  settings,
  grant,
  fs = { realpath: realpathSync, stat: statSync },
) {
  const shown = grant ?? grantFor(grantsFrom({}, config), config, repo);
  return {
    settings: settingRows(config, settings, shown),
    hosts: hostRows(config, shown),
    mounts: mountRows(settings, shown, fs),
    grant: grant ? grantRows(grant) : null,
  };
}
