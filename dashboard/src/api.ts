// The listener's API: api/state polled, a run's log streamed (server-sent events), the
// repositories listed and onboarded.
// Relative URLs, like the assets: the page works under any path.
import { useEffect, useState } from "preact/hooks";
import type { Entry, Onboarded, Repo, Repos, State } from "./types";

const POLL_MS = 3000;

export function useAppState(): { state: State | null; error: string | null } {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const res = await fetch("api/state", { cache: "no-store" });
        // Signed out (or no longer an allowed user): the sign-in page.
        if (res.status === 401) return location.reload();
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as State;
        if (!stopped) {
          setState(next);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return { state, error };
}

// A run's log so far, then live until it ends.
export function useRunLog(runId: string | null): { entries: Entry[]; ended: boolean } {
  const [log, setLog] = useState<{ id: string | null; entries: Entry[]; ended: boolean }>({
    id: null,
    entries: [],
    ended: false,
  });
  useEffect(() => {
    setLog({ id: runId, entries: [], ended: false });
    if (!runId) return;
    const source = new EventSource(`api/runs/${encodeURIComponent(runId)}/stream`);
    source.addEventListener("entries", (event) => {
      const more = JSON.parse((event as MessageEvent).data) as Entry[];
      setLog((l) => (l.id === runId ? { ...l, entries: [...l.entries, ...more] } : l));
    });
    source.addEventListener("end", () => {
      source.close();
      setLog((l) => (l.id === runId ? { ...l, ended: true } : l));
    });
    return () => source.close();
  }, [runId]);
  return log.id === runId ? log : { entries: [], ended: false };
}

// The listener caches the list for minutes: polling it now and then costs GitHub nothing.
const REPOS_POLL_MS = 60000;

export interface RepoList {
  repos: Repo[] | null;
  error: string | null;
  // The repo whose onboarding is being started, and the last failure to.
  starting: string | null;
  failed: { repo: string; error: string } | null;
  onboard: (repo: string) => Promise<void>;
}

export function useRepos(): RepoList {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<RepoList["failed"]>(null);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const res = await fetch("api/repos", { cache: "no-store" });
        if (res.status === 401) return location.reload();
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as Repos;
        if (!stopped) {
          setRepos(next.repos);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    refresh();
    const timer = setInterval(refresh, REPOS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const onboard = async (repo: string) => {
    setStarting(repo);
    setFailed(null);
    try {
      const res = await fetch(`api/repos/${repo}/onboard`, { method: "POST" });
      const answer = (await res.json().catch(() => ({}))) as Onboarded;
      const row = answer.repo;
      if (row) setRepos((all) => all && all.map((r) => (r.repo === row.repo ? row : r)));
      if (!res.ok) setFailed({ repo, error: answer.error ?? String(res.status) });
    } catch (e) {
      setFailed({ repo, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setStarting(null);
    }
  };

  return { repos, error, starting, failed, onboard };
}
