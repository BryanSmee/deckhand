// The address says what is shown, so a link opens the same view:
//   #/all                         every repo
//   #/org/repo                    one repo's tab
//   #/org/repo?task=<key>&run=<id> with a task (and one of its runs) open
//   #/repositories                the repositories the App is installed on
// Links from before the tabs ("#task=<key>&run=<id>") open the task in the All tab.

export interface Route {
  repo: string | null; // null: All
  task: string | null;
  run: string | null; // null: the latest, followed as new runs start
  page?: "repositories"; // instead of the tasks
}

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (!h.startsWith("/")) {
    const old = new URLSearchParams(h);
    return { repo: null, task: old.get("task"), run: old.get("run") };
  }
  const [path, query = ""] = h.slice(1).split("?", 2);
  if (path === "repositories") return { repo: null, task: null, run: null, page: path };
  const params = new URLSearchParams(query);
  const repo = /^[\w.-]+\/[\w.-]+$/.test(path) ? path : null;
  return { repo, task: params.get("task"), run: params.get("run") };
}

export function formatRoute({ repo, task, run, page }: Route): string {
  if (page) return `#/${page}`;
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (task && run) params.set("run", run);
  const query = params.toString();
  return `#/${repo ?? "all"}${query ? `?${query}` : ""}`;
}
