// The address says what is shown, so a link opens the same view:
//   #/                                   every repo's tasks (the Overview, later)
//   #/org/repo                           one repo's tasks
//   #/org/repo?task=<key>&run=<id>       with a task (and one of its runs) open; #/?task=… on All
//   #/org/repo/board                     a repo's board: its work queue, and what waits for what
//   #/settings/repositories              the repositories the App is installed on
//   #/settings/repositories/org/repo     with one's config open
//   #/settings/preferences, #/settings/server   Settings' other tabs
// Older addresses still parse, and the dashboard rewrites them to these (App.tsx useRoute()):
// #/all, #/repositories[/org/repo], #/graph[/org/repo] (the board), and links from before the
// tabs ("#task=<key>&run=<id>"). Every repo's board is gone (the Overview replaces it): #/board
// and #/graph open every repo's tasks.

export type Page = "board" | "settings";
// Settings' tabs besides Repositories (its first, and the one with no `section`).
export type Section = "preferences" | "server";

export interface Route {
  repo: string | null; // null: All
  task: string | null;
  run: string | null; // null: the latest, followed as new runs start
  page?: Page; // instead of the tasks
  config?: string | null; // settings: the repository whose config is open
  section?: Section; // settings: another tab than Repositories
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
  // Settings: Repositories (#/settings alone too), Preferences or Server.
  const repos = /^(?:settings\/repositories|repositories)(?:\/([\w.-]+\/[\w.-]+))?$/.exec(path);
  if (repos) return { ...tasks(null), page: "settings", ...(repos[1] ? { config: repos[1] } : {}) };
  const section = /^settings\/(preferences|server)$/.exec(path);
  if (section) return { ...tasks(null), page: "settings", section: section[1] as Section };
  if (/^settings(?:\/[\w-]+)?$/.test(path)) return { ...tasks(null), page: "settings" };
  const board = /^(?:graph\/([\w.-]+\/[\w.-]+)|([\w.-]+\/[\w.-]+)\/board)$/.exec(path);
  if (board) return { ...tasks(board[1] ?? board[2]), page: "board" };
  if (path === "board" || path === "graph") return tasks(null);
  const params = new URLSearchParams(query);
  const repo = REPO.test(path) ? path : null;
  return { repo, task: params.get("task"), run: params.get("run") };
}

export function formatRoute({ repo, task, run, page, config, section }: Route): string {
  if (page === "settings" && section) return `#/settings/${section}`;
  if (page === "settings") return `#/settings/repositories${config ? `/${config}` : ""}`;
  if (page === "board" && repo) return `#/${repo}/board`;
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (task && run) params.set("run", run);
  const query = params.toString();
  return `#/${repo ?? ""}${query ? `?${query}` : ""}`;
}
