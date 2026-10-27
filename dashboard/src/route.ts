// The address says what is shown, so a link opens the same view:
//   #/                                   every repo's tasks (the Overview, later)
//   #/org/repo                           one repo's tasks
//   #/org/repo?task=<key>&run=<id>       with a task (and one of its runs) open; #/?task=… on All
//   #/org/repo/board                     the graph of what waits for what in one repo
//   #/settings/repositories              the repositories the App is installed on
//   #/settings/repositories/org/repo     with one's config open
// Older addresses still parse, and the dashboard rewrites them to these (App.tsx useRoute()):
// #/all, #/repositories[/org/repo], #/graph/org/repo (its board), #/graph (the all-repositories
// graph is gone: All's tasks), and links from before the tabs ("#task=<key>&run=<id>").

export type Page = "board" | "settings";

export interface Route {
  repo: string | null; // null: All
  task: string | null;
  run: string | null; // null: the latest, followed as new runs start
  page?: Page; // instead of the tasks
  config?: string | null; // settings: the repository whose config is open
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const tasks = (repo: string | null): Route => ({ repo, task: null, run: null });

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (!h.startsWith("/")) {
    const old = new URLSearchParams(h);
    return { repo: null, task: old.get("task"), run: old.get("run") };
  }
  const [path, query = ""] = h.slice(1).split("?", 2);
  // Settings: its Repositories page is the only one yet; Preferences and Server open it too.
  const repos = /^(?:settings\/repositories|repositories)(?:\/([\w.-]+\/[\w.-]+))?$/.exec(path);
  if (repos) return { ...tasks(null), page: "settings", ...(repos[1] ? { config: repos[1] } : {}) };
  if (/^settings(?:\/[\w-]+)?$/.test(path)) return { ...tasks(null), page: "settings" };
  const graph = /^graph(?:\/([\w.-]+\/[\w.-]+))?$/.exec(path);
  if (graph) return graph[1] ? { ...tasks(graph[1]), page: "board" } : tasks(null);
  const board = /^([\w.-]+\/[\w.-]+)\/board$/.exec(path);
  if (board) return { ...tasks(board[1]), page: "board" };
  const params = new URLSearchParams(query);
  const repo = REPO.test(path) ? path : null;
  return { repo, task: params.get("task"), run: params.get("run") };
}

export function formatRoute({ repo, task, run, page, config }: Route): string {
  if (page === "settings") return `#/settings/repositories${config ? `/${config}` : ""}`;
  if (page === "board" && repo) return `#/${repo}/board`;
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (task && run) params.set("run", run);
  const query = params.toString();
  return `#/${repo ?? ""}${query ? `?${query}` : ""}`;
}
