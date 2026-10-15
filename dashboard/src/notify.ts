// Pull requests ready for review: counted in the tab's title, and a browser notification for
// each one that turns ready while the page is open. Not for those already ready when it
// loaded, nor those the listener found without a webhook (no readyAt).
import { useEffect, useRef, useState } from "preact/hooks";
import { isReady, titleOf } from "./format";
import type { State } from "./types";

export type Permission = NotificationPermission | "unsupported";

const supported = () => typeof Notification !== "undefined";

export function useReadyNotifications(state: State | null) {
  const [permission, setPermission] = useState<Permission>(() =>
    supported() ? Notification.permission : "unsupported",
  );
  // The server's clock when the page got its first state: what was ready before is old news.
  const since = useRef<number | null>(null);
  const shown = useRef(new Set<string>());

  const ready = state?.tasks.filter(isReady).length ?? 0;
  useEffect(() => {
    document.title = ready ? `(${ready}) Deckhand` : "Deckhand";
  }, [ready]);

  useEffect(() => {
    if (!state) return;
    if (since.current === null) {
      since.current = state.now;
      return;
    }
    for (const t of state.tasks) {
      const pr = t.pr;
      if (pr?.state !== "ready" || !pr.readyAt || pr.readyAt <= since.current) continue;
      // Draft and ready again: a new readyAt, so a new notification.
      const id = `${t.key}@${pr.readyAt}`;
      if (shown.current.has(id)) continue;
      shown.current.add(id);
      if (!supported() || Notification.permission !== "granted") continue;
      const n = new Notification(`Ready for review: ${titleOf(t)}`, {
        body: `${t.repo} · pull request #${pr.number}`,
        tag: id,
      });
      n.onclick = () => {
        window.open(pr.url, "_blank", "noreferrer");
        n.close();
      };
    }
  }, [state]);

  // Asked from a button only: browsers ignore (or penalise) a request nobody clicked for.
  const ask = async () => {
    if (!supported()) return;
    setPermission(await Notification.requestPermission());
  };
  return { ready, permission, ask };
}
