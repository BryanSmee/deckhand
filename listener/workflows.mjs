// A repo's workflows (#1040): `.deckhand/workflows/*.yaml` on its default branch, read as its
// policies are (policies.mjs): the folder listed and kept until that branch moves (forget(),
// on the deliveries that say so) or LISTING_MS passes, each file fetched once by its blob sha
// and parsed (workflow-format.mjs). Any error in any file, or two triggers for one event, and
// the repo's workflows don't run at all: fail closed, as a config with errors starts nothing.
import { commitCi } from "./ci.mjs";
import { getJson, paginate } from "./github.mjs";
import { keepLast } from "../lib/capped.mjs";
import {
  builtInWorkflow,
  checkTriggers,
  errorText,
  MAX_FILES,
  parseWorkflow,
  WORKFLOW_DIR,
  WORKFLOW_FILE,
} from "./workflow-format.mjs";

// How long a listing is kept: a push to the default branch forgets it sooner.
const LISTING_MS = 10 * 60_000;
const MAX_REPOS = 1000;
const MAX_PARSED = 500;

// `github(repo, method, path, body, expected)`: the App's calls; `config`: the operator's, whose
// agents a step's `agent` must be one of (unchecked without).
export function createWorkflows({ github, config = null, now = Date.now }) {
  // "org/repo" (lower case) → { ref, at, listed }: the folder as last listed on that ref.
  const listings = new Map();
  // A file's parse by its blob sha and name: { workflow, errors }.
  const parsed = new Map();

  async function listing(repo, ref, cached) {
    const key = repo.toLowerCase();
    const kept = listings.get(key);
    if (cached && kept?.ref === ref && now() - kept.at < LISTING_MS) return kept.listed;
    const path = `/repos/${repo}/contents/${WORKFLOW_DIR}?ref=${encodeURIComponent(ref)}`;
    const found = await getJson(github, repo, path, [404]);
    const listed = Array.isArray(found) ? found : null;
    if (cached) keepLast(listings, key, { ref, at: now(), listed }, MAX_REPOS);
    return listed;
  }

  // The repo's workflows on `ref` → { workflows, errors, warnings }, `settings` its config's (the
  // built-in loop's trigger). `cached`: the default branch's listing, kept; a branch's is read
  // anew (the onboarding pull request's check).
  async function read(repo, ref, settings, { cached = true } = {}) {
    const listed = await listing(repo, ref, cached);
    const workflows = [];
    const errors = [];
    const warnings = [];
    if (!listed) return { workflows, errors, warnings };
    const files = listed.filter((e) => e.type === "file" && WORKFLOW_FILE.test(e.name));
    for (const e of listed) {
      if (e.type === "file" && /\.yml$/.test(e.name)) {
        warnings.push(`\`${WORKFLOW_DIR}/${e.name}\`: ignored, a workflow's file ends in .yaml`);
      }
    }
    if (files.length > MAX_FILES) {
      errors.push({ file: WORKFLOW_DIR, line: null, message: `over ${MAX_FILES} workflows` });
      return { workflows, errors, warnings };
    }
    for (const entry of files) {
      const id = `${entry.sha}:${entry.name}`;
      if (!parsed.has(id)) {
        const blob = await getJson(github, repo, `/repos/${repo}/git/blobs/${entry.sha}`);
        const text = Buffer.from(blob.content ?? "", blob.encoding ?? "base64").toString();
        const agents = config?.agents ?? null;
        keepLast(parsed, id, parseWorkflow(entry.name, text, { agents }), MAX_PARSED);
      }
      const { workflow, errors: found } = parsed.get(id);
      errors.push(...found);
      if (workflow) workflows.push(workflow);
    }
    errors.push(...checkTriggers(workflows, settings));
    return { workflows, errors, warnings };
  }

  // The workflow that runs `event` in `repo` (its default branch `ref`): its own, else the
  // built-in one (on `ready`, the one `settings`' `review:` compiles to), else null.
  // → { workflow, errors }: with errors, no workflow runs.
  async function forEvent(repo, ref, settings, event) {
    const { workflows, errors } = await read(repo, ref, settings);
    if (errors.length) {
      return { workflow: null, errors: errors.map(errorText) };
    }
    const own = workflows.find((w) => w.on.includes(event));
    return { workflow: own ?? builtInWorkflow(event, settings), errors: [] };
  }

  // `repo`'s default branch moved, or the repo left the App's reach: listed again next time.
  function forget(repo) {
    listings.delete(repo.toLowerCase());
  }

  return { read, forEvent, forget };
}

// What a workflow's conditions read of pull request `pr` (GitHub's), for the engine's facts():
// each asked of GitHub only when a condition needs it. No review here: no severity.
export function pullFacts(github, repo, pr) {
  const head = pr.head?.sha ?? null;
  const names = (files) => files.map((f) => f.filename);
  return {
    head: () => head,
    labels: () => (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)),
    files: async () =>
      names(
        await paginate(
          (path) => github(repo, "GET", path),
          `/repos/${repo}/pulls/${pr.number}/files`,
        ),
      ),
    ci: async () => (head ? ((await commitCi(github, repo, head))?.state ?? "none") : "none"),
    changedSince: async (sha) => {
      const path = `/repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(head)}`;
      return names((await getJson(github, repo, path))?.files ?? []);
    },
  };
}
