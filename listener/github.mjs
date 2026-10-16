// The App's GitHub calls as the listener's modules make them, on top of server.mjs's
// `github(repo, method, path, body, expected)` (github-app.mjs request()), which tests fake.
// Statuses in `expected` are normal for the call: not logged, and answered here as null.

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
