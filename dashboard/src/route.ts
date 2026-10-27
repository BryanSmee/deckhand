// The address says what is shown, so a link opens the same view:
//   #/                                   the Overview: what waits on you, a card per repo
//   #/tasks                              every repo's tasks
//   #/tasks?task=<key>&run=<id>          with a task (and one of its runs) open
//   #/org/repo                           one repo's tasks
//   #/org/repo?task=<key>&run=<id>       with a task (and one of its runs) open
//   #/org/repo/board                     a repo's board: its work queue, and what waits for what
//   #/settings/repositories              the repositories the App is installed on
//   #/settings/repositories/org/repo     with one's config open
//   #/settings/preferences, #/settings/server   Settings' other tabs
// Older addresses still parse, and the dashboard rewrites them to these (App.tsx useRoute()):
// #/all, #/?task=… (All's tasks), #/repositories[/org/repo], #/graph/org/repo (the board),
// #/board and #/graph (every repo's graph, now the Overview), and links from before the tabs
// ("#task=<key>&run=<id>").

// No page: a repo's tasks, or the Overview on All. "tasks" on All: every repo's tasks.
export type Page = "tasks" | "board" | "settings";
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
const overview = tasks(null);

// The Overview: All, with no page.
export const isOverview = (route: Route) => !route.repo && !route.page;

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (!h.startsWith("/")) {
    const old = new URLSearchParams(h);
    const task = old.get("task");
    return task ? { repo: null, task, run: old.get("run"), page: "tasks" } : overview;
  }
  const [path, query = ""] = h.slice(1).split("?", 2);
  // Settings: Repositories (#/settings alone too), Preferences or Server.
  const repos = /^(?:settings\/repositories|repositories)(?:\/([\w.-]+\/[\w.-]+))?$/.exec(path);
  if (repos) return { ...tasks(null), page: "settings", ...(repos[1] ? { config: repos[1] } : {}) };
  const section = /^settings\/(preferences|server)$/.exec(path);
  if (section) return { ...tasks(null), page: "settings", section: section[1] as Section };
  if (/^settings(?:\/[\w-]+)?$/.test(path)) return { ...tasks(null), page: "settings" };
  // The board is one repo's: every repo's graph is the Overview now.
  const board = /^(?:graph|board)$|^graph\/([\w.-]+\/[\w.-]+)$|^([\w.-]+\/[\w.-]+)\/board$/.exec(
    path,
  );
  if (board) {
    const repo = board[1] ?? board[2];
    return repo ? { ...tasks(repo), page: "board" } : overview;
  }
  const params = new URLSearchParams(query);
  const task = params.get("task");
  const opened = { task, run: task ? params.get("run") : null };
  if (REPO.test(path)) return { repo: path, ...opened };
  // All: its tasks, or the Overview (a task open on it is in All's tasks).
  return path === "tasks" || task ? { repo: null, ...opened, page: "tasks" } : overview;
}

export function formatRoute({ repo, task, run, page, config, section }: Route): string {
  if (page === "settings" && section) return `#/settings/${section}`;
  if (page === "settings") return `#/settings/repositories${config ? `/${config}` : ""}`;
  if (page === "board" && repo) return `#/${repo}/board`;
  if (!repo && page !== "tasks" && !task) return "#/";
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (task && run) params.set("run", run);
  const query = params.toString();
  return `#/${repo ?? "tasks"}${query ? `?${query}` : ""}`;
}
