// The Workflow tab's editor (#1042, stage 4 of #899): a repo's `.deckhand/workflows/*.yaml`
// edited in the dashboard, beside its graph. Its routes, under api/repos/<owner>/<repo>/workflows:
//
//   GET                the files on the default branch (their texts), Deckhand's built-in ones
//                      (compiled from `review:`), the past pull requests a dry run can replay,
//                      and how many open pull requests run each version (an instance keeps the
//                      one it started with: workflow-engine.mjs);
//   POST …/check       a text parsed as it is typed (workflow-format.mjs), its steps for the
//                      graph, its errors with their lines, the triggers checked with the others;
//   POST …/dry-run     the what-if (workflow-what-if.mjs) on a past pull request;
//   POST …/save        the file committed to a new branch and a pull request opened by the App,
//                      saying who saved it (`repo:config:write`): it lands on the default branch
//                      like any other change, once reviewed and merged.
//
// None of it widens what a run may do: the editor only writes the file a person could, through
// a pull request, and a workflow orders steps that each still ask the policies.
import { randomUUID } from "node:crypto";
import { keepLast } from "../lib/capped.mjs";
import { readJsonBody, refuse, send } from "../lib/http.mjs";
import { repoAllowed } from "./config.mjs";
import { parseKey, pullEntry, sameRepo } from "./events.mjs";
import { getJson } from "./github.mjs";
import { READY } from "./review-workflow.mjs";
import { apiRoute } from "./web.mjs";
import {
  BUILT_IN_CONFLICTS,
  builtInWorkflow,
  checkTriggers,
  conditionText,
  errorText,
  MAX_FILE_BYTES,
  parseWorkflow,
  reviewWorkflow,
  WORKFLOW_DIR,
  WORKFLOW_FILE,
} from "./workflow-format.mjs";
import { recordedHistory, whatIf } from "./workflow-what-if.mjs";
import { pullFacts } from "./workflows.mjs";

// A body: a workflow's text (MAX_FILE_BYTES, a few times over once JSON-escaped) and its picks.
const MAX_BODY = 4 * MAX_FILE_BYTES + 8192;
// The past pull requests offered for a dry run, newest first.
const MAX_PULLS = 30;
const MAX_PICKS = 100;
// How long a check or a dry run reuses what it read of a repo, and how many repos are kept.
const READ_MS = 60_000;
const MAX_KEPT = 50;

const plain = (text) => String(text).replaceAll("`", "");

// A parsed step (workflow-format.mjs) as the dashboard draws it: its kind, its line (its id in
// the graph and the dry run's trail) and what it says, its condition as text.
export function stepView(step) {
  const kind = step.repeat ? "repeat" : step.then ? "if" : step.run ? "run" : "comment";
  const view = { line: step.line, kind };
  for (const key of ["run", "say", "count", "set", "agent", "model", "effort", "instructions"]) {
    if (step[key] !== undefined) view[key] = step[key];
  }
  if (step.comment !== undefined && !step.say) view.comment = step.comment;
  if (step.if) view.if = conditionText(step.if);
  if (step.max) view.max = step.max;
  for (const key of ["then", "else", "repeat"]) {
    if (step[key]) view[key] = step[key].map(stepView);
  }
  return view;
}

// What GET answers of a workflow's instance's version among `open` (instances, task key →
// { [event]: instance }) of `repo`: per workflow (its file, null for Deckhand's built-in one)
// and event, how many open pull requests run `current` (the version on the default branch) and
// how many an older one.
export function versionCounts(open, repo, current) {
  const counts = new Map();
  for (const [key, events] of open) {
    if (!sameRepo(parseKey(key)?.repo, repo)) continue;
    for (const inst of Object.values(events ?? {})) {
      const file = inst?.workflow?.file ?? null;
      const id = `${file ?? ""}:${inst?.event}`;
      const now = current.get(id);
      const count = counts.get(id) ?? { file, event: inst?.event, current: 0, older: 0 };
      if (now && inst.workflow.version === now) count.current += 1;
      else count.older += 1;
      counts.set(id, count);
    }
  }
  return [...counts.values()];
}

// `ctx`: the orchestrator's (server.mjs), once wired (http.mjs makes it at its first request):
// its `github`, `config`, `repoSettings`, `permissions`, `workflows` (workflows.mjs's reader),
// `reviews`, `decisions`, `publicUrl` and
// `workflowInstances` (the engine's store map); `now`, a clock (Date.now without).
export function createWorkflowEditor(ctx) {
  const github = (...args) => ctx.github(...args);
  const json = (repo, path, expected) => getJson(github, repo, path, expected);
  const log = (text) => ctx.log?.(text);

  const now = () => (ctx.now ?? Date.now)();
  // What a check or a dry run reads of a repo beside its workflows, kept READ_MS: the dashboard
  // checks after each pause in the typing, and the repo's runs share the installation's rate
  // limit. "org/repo" (lower case) → { at, info, base, settings }. GET and Save read afresh.
  const kept = new Map();

  // What GitHub says of `repo` (its default branch, its address), its settings there, and its
  // workflows' files as the reader has them (workflows.mjs files(): its listing kept until the
  // default branch moves, the blobs by sha), so a check reads what runs. `fresh`: all read anew.
  async function readRepo(repo, { fresh = false } = {}) {
    const key = repo.toLowerCase();
    let known = kept.get(key);
    if (fresh || !known || now() - known.at >= READ_MS) {
      const info = await json(repo, `/repos/${repo}`);
      const base = info.default_branch || "main";
      const read = await ctx.repoSettings(repo, base);
      known = { at: now(), info, base, settings: read.settings };
      keepLast(kept, key, known, MAX_KEPT);
    }
    const found = await ctx.workflows.files(repo, known.base, { cached: !fresh });
    return { ...known, files: found.files, folderErrors: found.errors };
  }

  // `text` parsed as file `name` of `repo`, the other files of `base` beside it, as the reader
  // would read them once it lands: { workflow, errors }, each error { line, message } of this
  // file (its triggers' with the others' too), or of another file (`file`).
  // The other files' errors are said too (with their `file`): one stops every workflow there.
  async function check({ files: found, folderErrors = [], settings }, name, text) {
    const agents = ctx.config?.agents ?? null;
    const parsed = parseWorkflow(name, text, { agents });
    const errors = parsed.errors.map(({ file, line, message }) => ({ file, line, message }));
    const others = [];
    for (const f of found.filter((f) => f.name !== name)) {
      const { workflow, errors: wrong } = ctx.workflows.parse(f);
      errors.push(...wrong);
      if (workflow) others.push(workflow);
    }
    errors.push(...folderErrors);
    if (parsed.workflow) errors.push(...checkTriggers([...others, parsed.workflow], settings));
    const own = `${WORKFLOW_DIR}/${name}`;
    return {
      workflow: errors.length ? null : parsed.workflow,
      steps: parsed.workflow ? parsed.workflow.steps.map(stepView) : null,
      on: parsed.workflow?.on ?? [],
      errors: errors.map((e) => ({
        file: e.file === own ? null : e.file,
        line: e.line,
        message: plain(e.message),
      })),
    };
  }

  // A body's file name and text, checked: a name the reader takes, a text within its bounds.
  function asked(body) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const text = typeof body?.text === "string" ? body.text : null;
    if (!WORKFLOW_FILE.test(name)) {
      refuse(400, `A workflow's file name: letters, digits, ., _ and -, ending in .yaml.`);
    }
    if (text === null) refuse(400, "No workflow text.");
    return { name, text };
  }

  async function list(req, res, user, repo) {
    const { info, base, settings, files: found } = await readRepo(repo, { fresh: true });
    // The version each workflow runs at now: the file's text, or the one `review:` compiles to.
    const current = new Map();
    for (const f of found) {
      const parsed = ctx.workflows.parse(f).workflow;
      for (const event of parsed?.on ?? []) current.set(`${parsed.file}:${event}`, parsed.version);
    }
    const builtIn = {};
    for (const event of [READY, "conflict"]) {
      const workflow = builtInWorkflow(event, settings);
      builtIn[event] = !workflow
        ? null
        : event === READY
          ? reviewWorkflow(settings.review)
          : BUILT_IN_CONFLICTS;
      if (workflow) current.set(`:${event}`, workflow.version);
    }
    const branch = base.split("/").map(encodeURIComponent).join("/");
    send(res, 200, {
      base,
      files: found.map((f) => ({
        name: f.name,
        file: `${WORKFLOW_DIR}/${f.name}`,
        text: f.text,
        sha: f.sha,
        url: `${info.html_url}/blob/${branch}/${WORKFLOW_DIR}/${f.name}`,
      })),
      builtIn,
      running: versionCounts(ctx.workflowInstances ?? new Map(), repo, current),
      pulls: pastPulls(repo),
    });
  }

  // The pull requests of `repo` whose review loop left a history (reviews.mjs entries, kept 90
  // days after their last review), newest first: { number, at, reviews, fixes, merged }.
  function pastPulls(repo) {
    const out = [];
    for (const key of ctx.reviews?.keys() ?? []) {
      const parsed = parseKey(key);
      if (parsed?.kind !== "pr" || !sameRepo(parsed.repo, repo)) continue;
      const entry = ctx.reviews.entry(parsed.repo, parsed.number);
      const rounds = (entry?.rounds ?? []).filter((r) => !r.manual);
      if (!rounds.length && !entry?.ciStopped) continue;
      out.push({
        number: parsed.number,
        at: Math.max(entry.at ?? 0, ...rounds.map((r) => r.at ?? 0)),
        reviews: rounds.length,
        fixes: entry.fixes ?? (entry.fixedAt ? 1 : 0),
        merged: !!entry.mergedAt,
      });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_PULLS);
  }

  async function checked(req, res, user, repo) {
    const { name, text } = asked(await readJsonBody(req, MAX_BODY));
    const { workflow, ...view } = await check(await readRepo(repo), name, text);
    send(res, 200, view);
  }

  async function dryRun(req, res, user, repo) {
    const body = await readJsonBody(req, MAX_BODY);
    const { name, text } = asked(body);
    const number = Number(body?.pr);
    if (!Number.isInteger(number) || number < 1) refuse(400, "Pick a pull request.");
    const picks = Array.isArray(body?.picks) ? body.picks.slice(0, MAX_PICKS).map(String) : [];
    const { settings } = await readRepo(repo);
    const parsed = parseWorkflow(name, text, { agents: ctx.config?.agents ?? null });
    if (!parsed.workflow) refuse(422, "The workflow has errors: fix them first.");
    const { workflow } = parsed;
    const event = workflow.on.includes(READY) ? READY : workflow.on[0];
    const pr = await json(repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr) refuse(404, `No pull request #${number} in ${repo}.`);
    // On `ready`, the review loop's history; a conflict's isn't kept beyond its last attempt.
    const entry = ctx.reviews?.entry(repo, number) ?? null;
    const decisions = (ctx.decisions?.get(pullEntry(repo, pr).key) ?? []).filter(
      (d) => d.pr === number,
    );
    const history = event === READY ? recordedHistory(entry, decisions) : [];
    const result = await whatIf({
      workflow,
      event,
      history,
      picks,
      tolerance: settings.review?.maxAllowedSeverity ?? "low",
      read: pullFacts(github, repo, pr),
      maxRounds: ctx.config?.maxFixRounds ?? Infinity,
    });
    send(res, 200, {
      pr: { number, title: pr.title ?? "", url: pr.html_url ?? null },
      event,
      history: history.map(({ run, outcome }) => ({ run, outcome })),
      ...result,
    });
  }

  // The file committed on a new branch from the default branch's head, and a pull request
  // opened, both by the App; the commit's trailer and the description name `user`. `sha`: the
  // blob the text was edited from (null for a new file): a file changed since is refused, not
  // overwritten.
  async function save(req, res, user, repo) {
    const body = await readJsonBody(req, MAX_BODY);
    const { name, text } = asked(body);
    const read = await readRepo(repo, { fresh: true });
    const { base } = read;
    const { errors } = await check(read, name, text);
    if (errors.length) {
      refuse(422, `The workflow has errors: ${errors.map((e) => plain(errorText(e))).join("; ")}`);
    }
    const path = `${WORKFLOW_DIR}/${name}`;
    const ref = encodeURIComponent(base);
    const existing = await json(repo, `/repos/${repo}/contents/${path}?ref=${ref}`, [404]);
    const was = typeof body?.sha === "string" && body.sha ? body.sha : null;
    if (existing && !was) {
      refuse(409, `${path} already exists on ${base}: open it, or pick another name.`);
    }
    if ((existing?.sha ?? null) !== was) {
      refuse(409, `${path} changed on ${base} since it was opened: read it again first.`);
    }
    const head = await json(repo, `/repos/${repo}/git/ref/heads/${base}`);
    const stem = name.replace(/\.yaml$/, "").toLowerCase();
    // A ref git takes whatever the file's name (`a..b.yaml` is one): letters, digits and dashes.
    const slug = stem.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
    const branch = `deckhand-workflow-${slug}-${randomUUID().slice(0, 8)}`;
    await write(repo, "POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: head.object.sha,
    });
    const verb = existing ? "Edit" : "Add";
    const by = await coAuthor(repo, user);
    await write(repo, "PUT", `/repos/${repo}/contents/${path}`, {
      message: `${verb} ${path} from Deckhand's dashboard\n\nSaved by @${user}.${by ? `\n\n${by}` : ""}`,
      content: Buffer.from(text).toString("base64"),
      branch,
      ...(existing && { sha: existing.sha }),
    });
    const pull = await write(repo, "POST", `/repos/${repo}/pulls`, {
      title: `${verb} the ${stem} workflow`,
      head: branch,
      base,
      body: saveBody(user, path, existing),
    });
    log(`Workflows: ${repo}: ${user} saved ${path}, pull request #${pull.number}`);
    send(res, 200, { number: pull.number, url: pull.html_url, branch });
  }

  // A write as the App, its answer's body; GitHub's refusal a 502 that says it.
  async function write(repo, method, path, value) {
    const answer = await github(repo, method, path, value);
    if (answer.ok) return answer.json();
    const said = await answer.json().catch(() => null);
    log(`Workflows: ${repo}: GitHub ${method} ${path}: ${answer.status} ${said?.message ?? ""}`);
    refuse(502, `GitHub refused it (${answer.status}${said?.message ? `: ${said.message}` : ""}).`);
  }

  // The commit's co-author line for `user` (GitHub's noreply address, from their id), or null
  // when GitHub doesn't say.
  async function coAuthor(repo, user) {
    try {
      const found = await json(repo, `/users/${encodeURIComponent(user)}`, [404]);
      if (!found?.id) return null;
      return `Co-authored-by: ${found.login} <${found.id}+${found.login}@users.noreply.github.com>`;
    } catch (error) {
      log(`Workflows: ${repo}: who ${user} is: ${error.message ?? error}`);
      return null;
    }
  }

  const handle = apiRoute({
    name: "Workflows",
    route: (pathname) => {
      const m = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/workflows(?:\/(check|dry-run|save))?$/.exec(
        pathname,
      );
      return m && { repo: `${m[1]}/${m[2]}`, what: m[3] ?? "list" };
    },
    gets: { list },
    posts: { check: checked, "dry-run": dryRun, save },
    allowed: (repo) => repoAllowed(ctx.config, repo),
    permissions: ctx.permissions ?? null,
    action: ({ what }) => (what === "save" ? "repo:config:write" : "repo:config:read"),
    publicUrl: () => ctx.publicUrl?.() ?? null,
    log,
  });

  return { handle };
}

// What the pull request's description says: who saved it and where it comes from.
function saveBody(user, path, existing) {
  return [
    `@${user} ${existing ? "edited" : "added"} \`${path}\` in Deckhand's dashboard (Settings › Repositories › a repository › Editor), which opened this pull request.`,
    "",
    "Like the rest of `.deckhand.yaml`'s config, the workflow applies once it is merged into the default branch. Open pull requests keep the version they started with; the new one applies to those that start after the merge.",
  ].join("\n");
}
