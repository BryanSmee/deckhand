// The listener's API: api/state polled, a run's log streamed (server-sent events).
// Relative URLs, like the assets: the page works under any path.
import { useEffect, useState } from "preact/hooks";
import type { Entry, State } from "./types";

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
