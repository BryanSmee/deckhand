// A parent issue dropped on the graph (work.mjs plan()): its open sub-issues, all levels down,
// read from GitHub, and what each of them waits for, from their "blocked by" links. A parent
// waits for its sub-issues, and they for what it is blocked by: the work it needs comes first.
import { issueOutcome, sameRepo } from "./events.mjs";
import { paginate } from "./github.mjs";
import { issueList } from "./waits.mjs";
import { refuse } from "../lib/http.mjs";

// The "owner/name" of an issue as the REST API describes it (sub-issues and blockers may be
// another repo's), or null.
function repoOf(issue) {
  if (issue.repository?.full_name) return issue.repository.full_name;
  return /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? "")?.[1] ?? null;
}

const unique = (list) => [...new Set(list)];

// The most open issues a drop lays out: each costs a few GitHub calls and an App comment in
// one request, and a failure halfway leaves part of it done.
export const MAX_TREE = 30;

// Whether the waits of `from`, followed from one blocker to the next, lead to `to` (`from`
// itself included). `blockersOf(n)`: what issue n waits for.
export function leadsTo(blockersOf, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(blockersOf(n) ?? []));
  }
  return false;
}

// The tree under issue `root` (GitHub's issue, open): { nodes, elsewhere, done }.
// `nodes`: number → { issue, parent, children, blockers }, parents before their sub-issues;
// `children` are the open sub-issues, `blockers` the open issues of `repo` it is blocked by,
// in the tree or not. `elsewhere`: "owner/repo#n" of sub-issues and blockers in another repo,
// left out (one whose repo isn't said too). `done`: the sub-issues closed as completed,
// skipped. A sub-issue closed without being done (not planned, a duplicate) refuses it all
// (422): its parent can't be done as planned; so does a tree over MAX_TREE open issues.
export async function readTree(github, repo, root) {
  const list = (path) => paginate((p) => github(repo, "GET", p), path);
  const here = (issue) => sameRepo(repoOf(issue), repo);
  const where = (issue) => `${repoOf(issue) ?? "an unknown repository"}#${issue.number}`;
  const nodes = new Map([[root.number, { issue: root, parent: null, children: [], blockers: [] }]]);
  const elsewhere = [];
  const done = [];
  const pending = [root.number];
  while (pending.length) {
    const n = pending.shift();
    const node = nodes.get(n);
    // GitHub says how many it has: one without any isn't asked.
    if (node.issue.sub_issues_summary?.total === 0) continue;
    for (const sub of await list(`/repos/${repo}/issues/${n}/sub_issues`)) {
      if (!here(sub)) {
        elsewhere.push(where(sub));
        continue;
      }
      const outcome = issueOutcome(sub);
      if (outcome === "done") done.push(sub.number);
      if (outcome === "not-done") {
        refuse(422, `#${sub.number}, a sub-issue of #${n}, was closed without being done.`);
      }
      // One parent per sub-issue on GitHub; met twice anyway, it is laid out once.
      if (outcome !== "open" || nodes.has(sub.number)) continue;
      if (nodes.size >= MAX_TREE) {
        refuse(
          422,
          `#${root.number} has over ${MAX_TREE} open issues under it: drop its nested parents one at a time instead.`,
        );
      }
      nodes.set(sub.number, { issue: sub, parent: n, children: [], blockers: [] });
      node.children.push(sub.number);
      pending.push(sub.number);
    }
  }
  for (const [n, node] of nodes) {
    if (node.issue.issue_dependencies_summary?.total_blocked_by === 0) continue;
    for (const b of await list(`/repos/${repo}/issues/${n}/dependencies/blocked_by`)) {
      if (b.state !== "open") continue;
      if (here(b)) node.blockers.push(b.number);
      else elsewhere.push(where(b));
    }
    node.blockers = unique(node.blockers);
  }
  return { nodes, elsewhere: unique(elsewhere), done: unique(done) };
}

// A path round the waits, from `starts` (["#11", "#12", "#11"] as numbers), or null: what
// leadsTo() finds, with the issues on the way to name them. `get(n)`: what n waits for.
export function cycleIn(get, starts) {
  const state = new Map();
  const path = [];
  const visit = (n) => {
    if (state.get(n) === "done") return null;
    if (state.get(n) === "on") return [...path.slice(path.indexOf(n)), n];
    state.set(n, "on");
    path.push(n);
    for (const b of get(n) ?? []) {
      const found = visit(b);
      if (found) return found;
    }
    path.pop();
    state.set(n, "done");
    return null;
  };
  for (const n of starts) {
    const found = visit(n);
    if (found) return found;
  }
  return null;
}

// What each issue of the tree waits for: number → [blockers], empty for those that start
// now. Each waits for its own blockers, its open sub-issues, and what its parents wait for
// (`after`, too, for the root: the issue it was dropped next to). A parent "blocked by" its
// own sub-issues (an epic by its tasks) says what its sub-issues already do: those links are
// left out, and not passed down to the sub-issues, which would then wait for themselves or
// for each other. A blocker reached through
// another it waits for is left out: #11 waits for #12, not for what #12 waits for as well. A
// parent keeps all its sub-issues: one closed by hand while another runs doesn't start it.
// `existing(n)`: what an issue outside the tree waits for already (waits.mjs), so that a loop
// through it is found too. Refuses a loop (422), naming its issues.
export function waitsOf(tree, { after = null, existing = () => [] } = {}) {
  // Parents come before their sub-issues: from the last one up, each gets its whole subtree.
  const below = new Map();
  for (const [n, node] of [...tree.nodes].reverse()) {
    below.set(n, new Set(node.children.flatMap((c) => [c, ...below.get(c)])));
  }
  const full = new Map();
  const above = new Map();
  for (const [n, node] of tree.nodes) {
    const own = node.blockers.filter((b) => b !== n && !below.get(n).has(b));
    const inherited =
      node.parent === null ? (after === null ? [] : [after]) : above.get(node.parent);
    above.set(n, unique([...inherited, ...own]));
    full.set(n, unique([...own, ...node.children, ...inherited]));
  }
  const get = (n) => full.get(n) ?? existing(n);
  const loop = cycleIn(get, full.keys());
  if (loop) {
    const steps = loop.slice(0, -1).map((n, i) => `#${n} waits for #${loop[i + 1]}`);
    refuse(422, `The issues wait for each other: ${steps.join(", ")}. Nothing starts.`);
  }
  // Within the tree only: an outside issue's wait may change before this one ends.
  const reaches = (from, to) => leadsTo((n) => full.get(n), from, to);
  return new Map(
    [...full].map(([n, blockers]) => [
      n,
      blockers.filter(
        (b) => tree.nodes.get(b)?.parent === n || !blockers.some((c) => c !== b && reaches(c, b)),
      ),
    ]),
  );
}

// What the reply says the drop did: "#12 and #13 start; #11 waits for #12; #10 waits for #11".
export function planSummary(order, planned) {
  const starts = order.filter((n) => !planned.get(n).length);
  const parts = starts.length ? [`${issueList(starts)} start${starts.length > 1 ? "" : "s"}`] : [];
  for (const n of order) {
    const blockers = planned.get(n);
    if (blockers.length) parts.push(`#${n} waits for ${issueList(blockers)}`);
  }
  return parts.join("; ");
}
