// Capabilities (issue #495): what a run's sandbox gets beyond the minimum every run has (its
// sandbox, the agent's API, the listener's endpoints for its run, its prompt with the text that
// triggered it: nothing of the repository's). Decided at the run's start by the policies
// (`allow_capabilities`, `deny_capabilities`: policies.mjs capabilityRules()), greedily: a
// capability the policies allow is used, when the config asks for it if it has a config side,
// and the operator's grant gives it if a grant gates it. Then checked here, in code, whatever a
// policy says: each capability's dependencies, and the risky combinations. One function,
// outcomeOf(), says what a run gets: runs start with it (preparation.mjs), and the repository's
// config page shows it for each mode (repos.mjs). Format: ../docs/repo-config.md#capabilities.
import { BUILT_IN, customMode, isLight, MODES, OPEN, permissionsFor } from "./modes.mjs";
import { ungranted } from "./grants.mjs";
import { POLICY_DIR } from "./policies.mjs";

// The catalogue: each capability's name, the capabilities it needs (`needs`), the
// .deckhand.yaml keys that ask for it (`config`, settings fields: repo-config.mjs) and the
// grant that gates it (`grant`, grants.mjs), if any: one the policies allow and the config asks
// for stops the run without its grant, unless `optional`. What it gives (`what`) and what enforces
// it (`enforcedBy`). The reads (#497) are decided here, and given to the token there: until
// then they need `pull`, without which a run gets no token at all (broker.mjs grant()).
export const CAPABILITIES = [
  {
    name: "pull",
    needs: [],
    what: "a clone of the repository: its code and history",
    // Without it, the run gets no GitHub token at all (broker.mjs grant()).
    enforcedBy: "the listener at start (the clone), the GitHub gateway (no token without it)",
  },
  {
    name: "push",
    needs: ["pull"],
    what: "its branches pushed, its issue's branch and draft pull request",
    enforcedBy: "the git gateway (the run token's branches)",
  },
  {
    name: "setup",
    needs: ["pull"],
    config: ["setup", "caches"],
    what: "the repository's setup command, and its caches",
    enforcedBy: "the listener at start",
  },
  {
    name: "image:repo",
    needs: ["pull"],
    config: ["dockerfile"],
    grant: "allowDockerfile",
    what: "the image built from the repository's Dockerfile",
    enforcedBy: "the listener at start",
  },
  {
    name: "image:branch",
    // The less trusted of the two images: a policy denying `image:repo` denies it too.
    needs: ["push", "image:repo"],
    config: ["dockerfile"],
    grant: "allowBranchDockerImages",
    // Without its grant, the run takes the repository's image instead: nothing stops it.
    optional: true,
    what: "on a pull request, the image built from its branch's Dockerfile",
    enforcedBy: "the listener at start",
  },
  {
    name: "docker",
    needs: ["pull"],
    config: ["docker"],
    grant: "allowDocker",
    what: "a container engine next to the sandbox",
    enforcedBy: "the listener at start",
  },
  {
    name: "preview",
    needs: [],
    config: ["preview"],
    grant: "allowPreview",
    what: "the repository's preview hook on its pull requests",
    // The hook runs on pull request events, whichever run opened them (previews.mjs).
    enforcedBy: "not per run yet: the hook runs on pull request events",
  },
  {
    name: "internet",
    needs: [],
    grant: "allowResearch",
    what: "any public host, beyond the hosts the operator grants",
    enforcedBy: "the egress proxy",
  },
  {
    name: "read:issues",
    needs: ["pull"],
    what: "the repository's issues",
    enforcedBy:
      "not yet: the run's token follows its mode until #497 (then the GitHub gateway, issues: read)",
  },
  {
    name: "read:pulls",
    needs: ["pull"],
    what: "the repository's pull requests",
    enforcedBy:
      "not yet: the run's token follows its mode until #497 (then the GitHub gateway, pull_requests: read)",
  },
  {
    name: "read:discussions",
    needs: ["pull"],
    what: "the repository's discussions",
    enforcedBy:
      "not yet: the run's token follows its mode until #497 (then the GitHub gateway, discussions: read)",
  },
  {
    name: "read:actions",
    needs: ["pull"],
    what: "its GitHub Actions runs and their logs",
    enforcedBy:
      "not yet: the run's token follows its mode until #497 (then the GitHub gateway, actions: read)",
  },
];

const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));
export const NAMES = CAPABILITIES.map((c) => c.name);

// The combinations refused unless an allow rule of the operator's names them (its `name`, as
// `allow_capabilities` gives it): a private repository's code, untrusted content from the open
// internet and a way out, in one run. Checked here so that replacing a default file can't drop
// them. `applies(repo)`: whether it is risky in that repo ({ private }, unknown counting as
// private).
export const RISKY = [
  {
    name: "pull+internet",
    capabilities: ["pull", "internet"],
    applies: (repo) => repo.private !== false,
    why: "a private repository's code next to the open internet: what a web page says could make the run send it out",
  },
];

// Every name an allow or deny rule may give: another one is a mistake the config check says.
export const KNOWN = new Set([...NAMES, ...RISKY.map((r) => r.name)]);

// What the policies read (docs/repo-config.md#capabilities). `repo`: { name, private
// }, private null when unknown; `issue`: the number of its issue or pull request; `reason`: why
// the listener started it itself ("review-fix", "ci-fix", "conflict", "review"…), null for a
// comment's; `fork`: whether a fork's pull request's comments started it; `trigger`: what a
// person started it from, as the run input says it (run-policy.mjs runTrigger(): "comment",
// "dashboard", "inbox", "discussion"), null for a run the listener starts itself; `command`:
// its last comment's first line ("work", "stop", "review"…), null when none.
export function capabilitiesInput({
  repo,
  mode,
  issue = null,
  reason = null,
  fork,
  trigger = null,
  command = null,
}) {
  return {
    // Lower case, as the run input's `repo` and the GitHub input's (run-policy.mjs runInput()).
    repo: {
      name: String(repo.name).toLowerCase(),
      private: typeof repo.private === "boolean" ? repo.private : null,
    },
    mode,
    custom_mode: !!mode && !BUILT_IN.has(mode),
    issue: Number.isInteger(issue) ? issue : null,
    reason: reason ?? null,
    fork: fork === true,
    trigger: trigger ?? null,
    command: command ?? null,
  };
}

// What the config asks for: a capability with a config side is used only when one of its keys
// is set.
const asked = (settings, c) =>
  !c.config || c.config.some((key) => [settings?.[key]].flat().some(Boolean));

// What a run gets → { capabilities, used, errors, warnings }: `capabilities`, one row per
// catalogue entry, { name, status, used, files, reason }: `status` "used", "denied" (a deny
// rule: `reason`), "not-allowed" (no allow rule of a layer that must allow it: `reason`),
// "not-asked" (the config doesn't ask for it), "not-granted" (the operator's grant doesn't give
// it); `files`, the policy files that decided ({ layer, file }: the allow rules that gave it, the
// deny rules that refused it). `used`: the names used. `errors`: what stops the run (a broken
// dependency, a risky combination the operator doesn't allow, one allowed and asked for that
// the grant doesn't give), `warnings`: the rest worth saying (a name nobody knows, a risky
// combination allowed, a repo's own mode its policies give nothing). Pure.
//
// `rules`: the policies' answer for the run (policies.mjs capabilityRules()), { operator, repo },
// each { allow: name → [files], deny: [{ capability, reason, file }] }, the repo's absent when it
// has no files; `custom`: whether its mode is the repo's own (it needs the repo's allow too);
// `settings`: the repo's (.deckhand.yaml); `grant`: the operator's (grants.mjs), null when it
// can't be read (nothing it gates is used); `repo`: { private }; `mode`: the run's, for the
// modes that can't do without `pull` (NEED_PULL).
export function outcomeOf({ rules, custom, settings, grant, repo, mode = null }) {
  const errors = [];
  const warnings = [];
  const layers = [
    ["operator", rules.operator],
    ["repo", rules.repo],
  ].filter(([, said]) => said);
  const denies = layers.flatMap(([layer, said]) => said.deny.map((d) => ({ ...d, layer })));
  for (const [layer, said] of layers) {
    for (const name of said.allow.keys()) {
      if (!KNOWN.has(name)) warnings.push(unknown("allow_capabilities", name, layer));
    }
  }
  for (const d of denies) {
    if (!KNOWN.has(d.capability))
      warnings.push(unknown("deny_capabilities", d.capability, d.layer));
  }
  // A risky combination counts only in the operator's allow rules: anywhere else, it does
  // nothing (deny one of its capabilities instead).
  const risky = new Set(RISKY.map((r) => r.name));
  for (const name of rules.repo?.allow.keys() ?? []) {
    if (risky.has(name)) warnings.push(ignoredRisk("allow_capabilities", name, "repo"));
  }
  for (const d of denies) {
    if (risky.has(d.capability))
      warnings.push(ignoredRisk("deny_capabilities", d.capability, d.layer));
  }
  const allowedBy = (layer, name) =>
    (rules[layer]?.allow.get(name) ?? []).map((file) => ({ layer, file }));
  const capabilities = CAPABILITIES.map((c) => {
    const row = (status, files = [], reason = null) => ({
      name: c.name,
      status,
      used: status === "used",
      files,
      reason,
    });
    const refused = denies.filter((d) => d.capability === c.name);
    if (refused.length) {
      return row(
        "denied",
        refused.map(({ layer, file }) => ({ layer, file })),
        refused.map((d) => d.reason).join("; "),
      );
    }
    const files = [...allowedBy("operator", c.name), ...(custom ? allowedBy("repo", c.name) : [])];
    if (!allowedBy("operator", c.name).length) {
      return row("not-allowed", [], "no allow rule of the operator's policies gives it");
    }
    if (custom && !allowedBy("repo", c.name).length) {
      return row("not-allowed", [], "no allow rule of the repository's policies gives it");
    }
    if (!asked(settings, c)) {
      return row("not-asked", files, `.deckhand.yaml doesn't set ${c.config.join(" or ")}`);
    }
    if (c.grant && !grant?.[c.grant]) return row("not-granted", files, grantNote(c));
    return row("used", files);
  });
  // A light mode's run doesn't get `push`, whatever the policies allow: its token can't push or
  // open a pull request (its mode's permissions and write ceiling, until #496 and #498), and
  // it would start as a work run in the light runs' volumes, which other runs reset without
  // stashing (sandbox-spec.mjs sessionOf()). What needs it goes with it (narrow()).
  const push = capabilities.find((c) => c.name === "push");
  if (mode !== null && isLight({ settings }, mode) && push.used) {
    const reason = `\`${mode}\` is a light mode: its token can't push or open a pull request until #496 and #498`;
    Object.assign(push, { status: "denied", used: false, files: [], reason });
    warnings.push(`\`push\` isn't used: ${reason}`);
  }
  const dropped = narrow(capabilities, warnings);
  for (const c of capabilities) {
    if (c.status === "not-granted" && !dropped.has(c.name) && !BY_NAME.get(c.name).optional) {
      errors.push(`\`${c.name}\`: ${c.reason}`);
    }
  }
  const used = capabilities.filter((c) => c.used).map((c) => c.name);
  // A repository's preview hook runs on its pull requests' events, not per run (previews.mjs):
  // a deny of `preview` doesn't stop it yet, which the page says rather than show it applied.
  const preview = capabilities.find((c) => c.name === "preview");
  if (
    preview.status === "denied" &&
    asked(settings, BY_NAME.get("preview")) &&
    grant?.allowPreview
  ) {
    warnings.push(
      "`preview` is denied, but the repository's preview hook still runs on its pull requests' events: the capabilities don't decide it yet",
    );
  }
  // The reads aren't the token's yet (#497): one refused while the run has `pull`, and so its
  // mode's token, is still read when that token has it.
  if (used.includes("pull") && mode !== null) {
    const token = permissionsFor(mode, isLight({ settings }, mode));
    for (const c of capabilities) {
      const permission = READ_PERMISSIONS[c.name];
      if (!permission || c.used || !["denied", "not-allowed"].includes(c.status)) continue;
      // undefined: the installation's own permissions, all of them.
      if (token !== undefined && !token?.[permission]) continue;
      warnings.push(
        `\`${c.name}\` isn't given, but the run's token still reads it until #497: its mode's permissions decide the token`,
      );
    }
  }

  // Modes that can't do without it: a review reads the diff and gives its verdict from it (the
  // listener parses it), a discussion's thread is read with its token (preparation.mjs reads
  // an issue's only).
  if (NEED_PULL[mode] && !used.includes("pull")) {
    errors.push(`a \`${mode}\` run needs \`pull\`: ${NEED_PULL[mode]}`);
  }
  // A research run has no token (its mode's NO_TOKEN, until #497 gives the reads to the token)
  // and its input is the thread prepareBare() writes: the clone it was given would fail.
  if (OPEN.has(mode) && used.includes("pull")) {
    errors.push(
      `a \`${mode}\` run can't have \`pull\` yet: it has no GitHub token to clone with (#497)`,
    );
  }
  // The repository's own modes need its allow rules too, which a repository written before
  // capabilities doesn't have: its runs would start without the code its mode expects, and the
  // full token their traits give (permissionsFor()) until #497. Refused, saying what to add.
  if (custom && !rules.repo?.allow.size) {
    errors.push(
      `no \`allow_capabilities\` rule of the repository's policies (${POLICY_DIR}/) gives this mode anything: add one naming what its runs get (\`pull\`, \`push\`, \`setup\`…)`,
    );
  }
  // What narrow() left: a capability whose need no allow rule gives, rules inconsistent on
  // their own.
  const has = new Set(used);
  for (const name of used) {
    for (const need of BY_NAME.get(name).needs) {
      if (!has.has(need)) errors.push(`\`${name}\` needs \`${need}\`, which the run doesn't get`);
    }
  }
  for (const risk of RISKY) {
    if (!risk.capabilities.every((c) => has.has(c)) || !risk.applies(repo)) continue;
    const named = allowedBy("operator", risk.name).length > 0;
    const said = `\`${risk.capabilities.join("` with `")}\`: ${risk.why}`;
    if (named) warnings.push(`${said} (the operator's \`${risk.name}\` allows it)`);
    else {
      errors.push(
        `${said}. Refused unless an allow rule of the operator's policies gives \`${risk.name}\``,
      );
    }
  }
  return { capabilities, used, errors, warnings };
}

// The token permission each read is until #497 maps them (outcomeOf()'s warning).
const READ_PERMISSIONS = {
  "read:issues": "issues",
  "read:pulls": "pull_requests",
  "read:discussions": "discussions",
  "read:actions": "actions",
};

// The built-in modes refused without `pull`, and why (outcomeOf()).
const NEED_PULL = {
  review: "it reviews the pull request's code, and its verdict decides fixes and merges",
  discussion: "it reads the discussion with its token",
};

// A deny narrows: a capability that needs one denied (or not asked for, or not granted) isn't
// used either, as that one (its status, the files that decided it), with a warning. "Forks
// don't push" then leaves a fork's run its code and reads, without `image:branch`, rather than
// refusing it. Repeated until nothing changes: `image:branch` goes with `push`, which goes with
// `pull`. A need no allow rule gives stays for outcomeOf() to refuse. One not granted whose
// need goes is dropped too, with no grant error: it would never be used. `rows`: outcomeOf()'s,
// changed in place. → the names dropped.
function narrow(rows, warnings) {
  const rowOf = (name) => rows.find((r) => r.name === name);
  // One not granted whose need goes too would never be used: no grant error for it.
  const dropped = new Set();
  const candidate = (r) => !dropped.has(r.name) && (r.used || r.status === "not-granted");
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows.filter(candidate)) {
      const missing = BY_NAME.get(row.name)
        .needs.map(rowOf)
        .find((need) => !need.used && need.status !== "not-allowed");
      if (!missing) continue;
      const reason = `it needs \`${missing.name}\`${missing.reason ? `: ${missing.reason}` : ""}`;
      if (row.used) warnings.push(`\`${row.name}\` isn't used: ${reason}`);
      Object.assign(row, { status: missing.status, used: false, files: missing.files, reason });
      dropped.add(row.name);
      changed = true;
    }
  }
  return dropped;
}

const ignoredRisk = (rule, name, layer) =>
  `\`${rule}\` of the ${layer === "repo" ? "repository's" : "operator's"} policies names \`${name}\`, which only an allow rule of the operator's counts: it does nothing here`;

const unknown = (rule, name, layer) =>
  `\`${rule}\` of the ${layer === "repo" ? "repository's" : "operator's"} policies names \`${name}\`, which isn't a capability Deckhand knows (${[...KNOWN].map((n) => `\`${n}\``).join(", ")})`;

// Why a capability its grant gates isn't used.
const GRANT_KEYS = {
  allowDockerfile: "allow_dockerfile",
  allowBranchDockerImages: "allow_branch_docker_images",
  allowDocker: "allow_docker",
  allowPreview: "allow_preview",
  allowResearch: "allow_research",
};
const grantNote = (c) =>
  `the operator's grants don't set \`${GRANT_KEYS[c.grant]}: true\` for this repository`;

// The modes a repository's runs can be in, as its config page lists them: the built-in ones
// that start a run (not `policy`, a dry run), `review` only with its `review` block, `research`
// only with its grant (`/mode research` is refused without: task-modes.mjs), then the repo's own
// (`modes:`). `grant`: the operator's (grants.mjs), null when it can't be read. → [{ mode,
// custom }]
export function modesOf(settings, grant = null) {
  const builtIn = Object.keys(MODES)
    .filter((mode) => mode !== "policy")
    .filter((mode) => mode !== "review" || !!customMode(settings, "review"))
    .filter((mode) => !OPEN.has(mode) || !!grant?.allowResearch);
  const own = Object.keys(settings?.modes ?? {}).filter((mode) => !BUILT_IN.has(mode));
  return [
    ...builtIn.map((mode) => ({ mode, custom: false })),
    ...own.map((mode) => ({ mode, custom: true })),
  ];
}

// The outcome for each mode of `settings` (modesOf()), as the config page shows it: the policies
// asked once for all (`decide(inputs)`: key → rules, or { error }). The input is a comment's run
// on an issue that isn't a fork's (`issue`, `reason` and `trigger` null): what a policy decides
// from those may differ for a given run. → [{ mode, custom, capabilities, used, errors,
// warnings }], or { error } when the policies couldn't be evaluated.
export async function modeOutcomes({ repo, settings, grant, decide }) {
  const modes = modesOf(settings, grant);
  const inputs = Object.fromEntries(
    modes.map(({ mode }) => [mode, capabilitiesInput({ repo, mode, fork: false, issue: null })]),
  );
  const said = await decide(inputs);
  if (said.error) return { error: said.error };
  return {
    modes: modes.map(({ mode, custom }) => {
      const outcome = outcomeOf({ rules: said.results[mode], custom, settings, grant, repo, mode });
      // Grants that can't be read stop every run before anything they gate (preparation.mjs
      // capabilitiesOf()): what the page says too.
      const unread = grant === null ? [GRANTS_UNREAD] : [];
      const errors = [...unread, ...outcome.errors, ...ungrantedFor(outcome, grant, settings)];
      return { mode, custom, ...outcome, errors };
    }),
  };
}

// What a run says when the operator's grants can't be read (access.mjs grantsRefusal()).
const GRANTS_UNREAD =
  "the operator's grants folder has errors, so no run starts (the Config tab says which)";

// What stops a run with a clone whatever it gets (access.mjs grantedAccess()): the config's keys
// the operator's grant doesn't give (grants.mjs ungranted()), as the config page says them, less
// those outcomeOf() already refused as a capability's.
function ungrantedFor({ used, errors }, grant, settings) {
  if (!grant || !used.includes("pull")) return [];
  const capabilityOf = { preview: "preview", dockerfile: "image:repo", docker: "docker" };
  return ungranted(grant, settings ?? {}).filter((line) => {
    const name = capabilityOf[line.split(":")[0]];
    return !errors.some((e) => e.startsWith(`\`${name}\`:`));
  });
}

// The names the repository's capabilities' rules give that the catalogue doesn't have, for the
// config check and the Config tab: its rules evaluated for every mode it may run in (research and
// reviews too: a rule may only name a capability for them), each name said once. A misspelled
// deny denies nothing, so it is said where the policies are checked, not only on the
// Capabilities tab. `decide(inputs)`: modeOutcomes()'s. The policies' errors are the compile
// check's to say: none here.
export async function capabilityNameWarnings({ repo, settings, decide }) {
  const modes = modesOf({ ...settings, review: settings?.review ?? {} }, { allowResearch: true });
  const inputs = Object.fromEntries(
    modes.map(({ mode }) => [mode, capabilitiesInput({ repo, mode, fork: false })]),
  );
  const said = await decide(inputs);
  if (said.error) return [];
  const warnings = new Set();
  for (const { repo: own } of Object.values(said.results)) {
    for (const name of own?.allow.keys() ?? []) {
      if (!KNOWN.has(name)) warnings.add(unknown("allow_capabilities", name, "repo"));
    }
    for (const d of own?.deny ?? []) {
      if (!KNOWN.has(d.capability))
        warnings.add(unknown("deny_capabilities", d.capability, "repo"));
    }
  }
  return [...warnings];
}

// The capabilities a run gets, for its log: "pull, push, setup" or "none".
export const listed = (used) => (used.length ? used.join(", ") : "none");

// The catalogue as the config page shows it: each capability's name, what it gives and needs,
// the .deckhand.yaml keys that ask for it, the grant that gates it and what enforces it.
export const catalogueView = () =>
  CAPABILITIES.map((c) => ({
    name: c.name,
    what: c.what,
    needs: c.needs,
    config: c.config ?? [],
    grant: c.grant ? GRANT_KEYS[c.grant] : null,
    enforcedBy: c.enforcedBy,
  }));
