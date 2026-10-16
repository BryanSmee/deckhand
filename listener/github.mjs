// The App's GitHub calls as the listener's modules make them, on top of
// `github(repo, method, path, body, expected)` (createGitHub(), github-app.mjs request()),
// which tests fake. Statuses in `expected` are normal for the call: not logged, and answered
// here as null. Also the lookups the dashboard's stores fall back on (titles, pulls, inputs).
import { issueOutcome } from "./events.mjs";
import { closedAs } from "./titles.mjs";

// The listener's `github` and `graphql`, as the repo's installation. `app()`: the GitHub App
// (github-app.mjs), null until /setup has stored one.
export function createGitHub(app) {
  // `expected`: error statuses that are normal for this call, so not logged.
  async function github(repo, method, path, body, expected = []) {
    if (!app()) throw new Error("the GitHub App is not set up");
    return app().request(repo, method, path, body, expected);
  }
  // Discussions are written to through GraphQL only. Its errors come with a 200: thrown there.
  const query = (repo, text, variables) => graphql(github, repo, text, variables);
  return { github, graphql: query };
}

// GET `path` as JSON, or null when GitHub answers a status in `expected` (404, 410: not
// there). Any other failure throws.
export async function getJson(github, repo, path, expected = []) {
  const res = await github(repo, "GET", path, undefined, expected);
  if (expected.includes(res.status)) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json();
}

export const PER_PAGE = 100;

// Every page of a list GitHub paginates. `get(path)`: the Response for a page (the repo's
// installation, or the App itself); `items(body)`: the page's entries, when the list isn't
// the body itself.
export async function paginate(get, path, items = (body) => body) {
  const all = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await get(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
    const found = items(await res.json());
    if (!Array.isArray(found)) throw new Error(`GitHub GET ${path}: no list`);
    all.push(...found);
    if (found.length < PER_PAGE) return all;
  }
}

// A GraphQL answer's data. Its errors come with a 200: thrown here, as a failed status is.
// `what`: the error's prefix.
export async function graphqlData(res, what = "GraphQL") {
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || answer.errors) {
    throw new Error(`${what}: ${res.status} ${JSON.stringify(answer.errors ?? answer)}`);
  }
  return answer.data;
}

// A GraphQL query or mutation as the repo's installation: its data, or it throws.
export async function graphql(github, repo, query, variables) {
  return graphqlData(await github(repo, "POST", "/graphql", { query, variables }));
}

// The first page of a list: the recent ones are enough there.
async function listOf(github, repo, path) {
  const list = await getJson(github, repo, path);
  if (!Array.isArray(list)) throw new Error(`GitHub GET ${path}: no list`);
  return list;
}

// A task's title and closed state, for the dashboard when no webhook brought them (titles.mjs).
export async function fetchTitle(github, repo, kind, number) {
  if (kind === "discussion") {
    const [owner, name] = repo.split("/");
    const data = await graphql(
      github,
      repo,
      "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { title } } }",
      { owner, name, number },
    );
    return { title: data.repository?.discussion?.title ?? null };
  }
  // Pull requests are issues too, for their title and whether they are merged.
  const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}`, [404]);
  return issue && { title: issue.title ?? null, closed: closedAs(issueOutcome(issue)) };
}

// The repo's pull requests, recently updated first (pulls.mjs).
export function listPulls(github, repo) {
  return listOf(
    github,
    repo,
    `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
  );
}

// The repo's open issues labelled `label` (inputs.mjs).
export function listLabelled(github, repo, label) {
  const name = encodeURIComponent(label);
  return listOf(
    github,
    repo,
    `/repos/${repo}/issues?labels=${name}&state=open&sort=updated&per_page=100`,
  );
}
