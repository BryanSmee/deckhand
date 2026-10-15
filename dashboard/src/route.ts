// The address says what is shown, so a link opens the same view:
//   #/all                         every repo
//   #/org/repo                    one repo's tab
//   #/org/repo?task=<key>&run=<id> with a task (and one of its runs) open
//   #/repositories                the repositories the App is installed on
//   #/repositories/org/repo       with one's config open
//   #/graph, #/graph/org/repo     the graph of every repo's issues, or one repo's
// Links from before the tabs ("#task=<key>&run=<id>") open the task in the All tab.

export interface Route {
  repo: string | null; // null: All
  task: string | null;
  run: string | null; // null: the latest, followed as new runs start
  page?: "repositories" | "graph"; // instead of the tasks
  config?: string | null; // the repository whose config is open there
}

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (!h.startsWith("/")) {
    const old = new URLSearchParams(h);
    return { repo: null, task: old.get("task"), run: old.get("run") };
  }
  const [path, query = ""] = h.slice(1).split("?", 2);
  if (path === "repositories") return { repo: null, task: null, run: null, page: path };
  const graph = /^graph(?:\/([\w.-]+\/[\w.-]+))?$/.exec(path);
  if (graph) return { repo: graph[1] ?? null, task: null, run: null, page: "graph" };
  const config = /^repositories\/([\w.-]+\/[\w.-]+)$/.exec(path);
  if (config) return { repo: null, task: null, run: null, page: "repositories", config: config[1] };
  const params = new URLSearchParams(query);
  const repo = /^[\w.-]+\/[\w.-]+$/.test(path) ? path : null;
  return { repo, task: params.get("task"), run: params.get("run") };
}

export function formatRoute({ repo, task, run, page, config }: Route): string {
  if (page === "graph") return `#/graph${repo ? `/${repo}` : ""}`;
  if (page) return `#/${page}${config ? `/${config}` : ""}`;
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (task && run) params.set("run", run);
  const query = params.toString();
  return `#/${repo ?? "all"}${query ? `?${query}` : ""}`;
}
