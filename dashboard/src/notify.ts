// Pull requests ready for review are counted in the tab's title. While the page is open, a
// browser notification, which opens its task, for each event Preferences has on: a pull
// request turning ready (not those already ready when it loaded, nor those the listener
// found without a webhook: no readyAt), once Deckhand's review-and-fix loop on it is over and
// with what that loop left (findingsLeft()), a run stopping for answers (questions, a brainstorm's turn), a run failing.
// Answers and failures are what changed between two states the page got: a task already
// waiting or failed when it loaded is old news.
import { useEffect, useRef, useState } from "preact/hooks";
import { findingsLeft, isReady, STATE_NAMES, titleOf, toneOf } from "./format";
import { getPref } from "./prefs";
import { formatRoute } from "./route";
import type { State, Task } from "./types";

export type Permission = NotificationPermission | "unsupported";

const supported = () => typeof Notification !== "undefined";

// What a task's state says to notify about, if anything.
type Event = "input" | "failed";
const eventOf = (t: Task): Event | null => {
  const tone = toneOf(t.state);
  return tone === "input" ? "input" : tone === "err" ? "failed" : null;
};

function show(title: string, options: NotificationOptions, onClick?: () => void) {
  if (!supported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      onClick?.();
      n.close();
    };
  } catch {
    // Android's Chrome only shows them from a service worker: the tab's title still counts.
  }
}

// The task, in this tab.
const openTask = (t: Task) => () => {
  window.focus();
  location.hash = formatRoute({ repo: t.repo, task: t.key, run: null });
};

export function useNotifications(state: State | null) {
  const [permission, setPermission] = useState<Permission>(() =>
    supported() ? Notification.permission : "unsupported",
  );
  // The server's clock when the page got its first state: what was ready before is old news.
  const since = useRef<number | null>(null);
  // Each task's event in the last state: one it was already in isn't new.
  const events = useRef(new Map<string, Event | null>());
  const shown = useRef(new Set<string>());

  const ready = state?.tasks.filter(isReady).length ?? 0;
  useEffect(() => {
    document.title = ready ? `(${ready}) Deckhand` : "Deckhand";
  }, [ready]);

  useEffect(() => {
    if (!state) return;
    const first = since.current === null;
    if (first) since.current = state.now;
    const before = events.current;
    events.current = new Map(state.tasks.map((t) => [t.key, eventOf(t)]));
    if (first) return;
    // Kept for each, whether it's on or not: turned on later, it doesn't show what was.
    const once = (id: string) => !shown.current.has(id) && !!shown.current.add(id);
    for (const t of state.tasks) {
      const pr = t.pr;
      if (pr && isReady(t) && pr.readyAt && pr.readyAt > since.current!) {
        // Draft and ready again: a new readyAt, so a new notification.
        const id = `${t.key}@${pr.readyAt}`;
        const left = findingsLeft(t);
        if (once(id) && getPref("notifyReady"))
          show(
            `Ready for review: ${titleOf(t)}`,
            { body: `${t.repo} · pull request #${pr.number}${left ? ` · ${left}` : ""}`, tag: id },
            openTask(t),
          );
      }
      const event = eventOf(t);
      if (!event || before.get(t.key) === event) continue;
      // The same run waiting or failed again after a moment elsewhere: still one.
      const id = `${t.key}@${event}@${t.runs[0]?.id ?? t.since}`;
      if (!once(id)) continue;
      if (event === "input" && getPref("notifyInput"))
        show(
          `Needs your answers: ${titleOf(t)}`,
          {
            body: `${t.repo} · ${t.state === "brainstorm" ? "a brainstorm waits for your turn" : "open questions"}`,
            tag: id,
          },
          openTask(t),
        );
      if (event === "failed" && getPref("notifyFailed"))
        show(
          `Run failed: ${titleOf(t)}`,
          { body: `${t.repo} · ${STATE_NAMES[t.state]}`, tag: id },
          openTask(t),
        );
    }
  }, [state]);

  // Asked from a button only: browsers ignore (or penalise) a request nobody clicked for.
  const ask = async () => {
    if (!supported()) return;
    setPermission(await Notification.requestPermission());
  };
  // Preferences' Send a test: what one looks like, here.
  const test = () =>
    show("Deckhand", {
      body: "Notifications work in this browser.",
      tag: "deckhand-test",
    });
  return { ready, permission, ask, test };
}

export type Notify = ReturnType<typeof useNotifications>;
