// The board's work queue: a panel of tabs beside the graph (a bottom sheet on a phone).
// Backlog: the repo's open issues with nothing live, to start, queue after another or
// brainstorm. Brainstorm: the issues being brainstormed, to start work on, queue or stop.
// Waiting: those waiting for others, to start now, queue after another or take out of their
// wait. Answers: those waiting for answers, which a start or a queue asks first. Each card has
// a button for each drag (on a phone, its first one and a menu for the rest), so phones and
// keyboards can do the same. The drags onto the graph are the board's (Board.tsx); the tabs
// take drops too: a card on Brainstorm brainstorms it, a brainstorm on Backlog stops it.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { WorkAreaState } from "./api";
import { Chooser, type Target } from "./Chooser";
import { BRAINSTORM_TYPE, dragEnded, dragOf, droppedIssue, ISSUE_TYPE, LINK_TYPES } from "./dnd";
import { issueList, plural, sameRepo, STATE_NAMES, when } from "./format";
import { type BrainstormCard } from "./graphModel";
import { typesOf, useDropZone } from "./hooks";
import type { Task, WorkAction } from "./types";
import { Button, IconButton } from "./ui/Button";
import { Field } from "./ui/Field";
import * as Icon from "./ui/icons";
import { Sheet } from "./ui/Sheet";
import { Notice } from "./ui/Surface";
import { Tabs } from "./ui/Tabs";
import styles from "./WorkQueue.module.css";

export type QueueTab = "backlog" | "brainstorm" | "waiting" | "answers";

// What can be done to a brainstorm now: start work on it, or stop it. Not while a reply or its
// wrap-up is on its way (the listener refuses a busy issue).
const movable = (c: BrainstormCard) =>
  !c.sending && (c.task?.state === "brainstorm" || c.task?.state === "idle-brainstorm");

// One of a card's buttons: an action (`run`), or "Queue after…" (`after`), which picks the
// issue to wait for first.
interface RowAction {
  label: string;
  // Its name when the label alone doesn't say which issue ("Start #31").
  aria?: string;
  run?: () => void;
  after?: (number: number) => void;
  icon?: ComponentChildren;
  disabled: boolean;
}

interface Row {
  key: string;
  number: number;
  title: string | null;
  // GitHub's page for it.
  href?: string;
  // The line under its title: its sub-issues, what it waits for, its state.
  meta: string;
  // Its drag, if it has one: the card's payload.
  drag?: (e: DragEvent) => void;
  actions: RowAction[];
}

// A tab's hint: what its cards' drags do.
const HINTS: Record<QueueTab, string> = {
  backlog:
    "Drag onto the board to start · onto a card to queue after it · onto the Brainstorm tab to brainstorm.",
  brainstorm:
    "Drag onto the board to start work · onto a card to queue after it · onto the Backlog tab to stop.",
  waiting:
    "On the board, drag a waiting card away to end its wait, or onto another card to wait for that one.",
  answers: "Drag onto the board to answer and start · onto a card to answer and queue after it.",
};

interface Props {
  repo: string;
  work: WorkAreaState;
  // The Brainstorm tab's cards, the waiting issues, those waiting for answers.
  cards: BrainstormCard[];
  waiting: Task[];
  answering: Task[];
  // What "Queue after…" offers: the graph's issues.
  targets: Target[];
  github: string;
  // The mode Start in picked ({} for work), and whether brainstorms can start here.
  picked: { mode?: string };
  brainstorms: boolean;
  // What the last action, answer or drop said; `failed`: a refusal.
  said: { text: string; failed: boolean } | null;
  tab: QueueTab;
  onTab: (tab: QueueTab) => void;
  // A phone: a bottom sheet, 44 px buttons, a menu for the rest, no drags.
  touch: boolean;
  // Takes an action: the board's, which opens an issue's open questions first.
  onAct: (action: WorkAction) => void;
  // What a drop that couldn't be sent says.
  onNotice: (notice: string | null) => void;
  // api/state's clock.
  now: number;
}

export function WorkQueue({
  repo,
  work,
  cards,
  waiting,
  answering,
  targets,
  github,
  picked,
  brainstorms,
  said,
  tab,
  onTab,
  touch,
  onAct,
  onNotice,
  now,
}: Props) {
  // The card whose "Queue after…" is open (over the page: Chooser.tsx), and what queues it
  // after the pick; the card whose menu is open (a phone's).
  const [choosing, setChoosing] = useState<{
    number: number;
    queue: (after: number) => void;
  } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  // The card being dragged: dimmed in its list meanwhile.
  const [dragging, setDragging] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // A phone's sheet: open, or its tabs alone.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setChoosing(null);
    setMenu(null);
    setFilter("");
  }, [repo, tab]);

  const { backlog, busy } = work;
  const blocked = !!backlog?.errors;
  const off = busy || blocked;
  const act = (action: WorkAction) => {
    setChoosing(null);
    setMenu(null);
    onNotice(null);
    onAct(action);
  };
  // Those an action on its way takes: they come back if it fails.
  const sent = new Set(work.pending.map((p) => p.number));
  const issues = backlog?.issues.filter((i) => !sent.has(i.number)) ?? [];
  const words = filter.trim().toLowerCase();
  const shown = issues.filter(
    (i) => !words || `#${i.number} ${i.title ?? ""}`.toLowerCase().includes(words),
  );

  // A brainstorm's card let go on Backlog: it stops.
  const stopZone = useDropZone(
    (e) => !blocked && typesOf(e).includes(BRAINSTORM_TYPE),
    (e) => {
      const number = Number(e.dataTransfer?.getData(BRAINSTORM_TYPE));
      if (number) act({ action: "stop", number });
    },
    { effect: "move" },
  );
  // An issue's card (or its link) let go on Brainstorm: it is brainstormed.
  const brainstormZone = useDropZone(
    (e) => {
      const types = typesOf(e);
      return (
        !blocked &&
        !types.includes(BRAINSTORM_TYPE) &&
        types.some((t) => [ISSUE_TYPE, ...LINK_TYPES].includes(t))
      );
    },
    (e) => {
      const number = droppedIssue(e.dataTransfer, [ISSUE_TYPE], github, repo);
      if (!number) {
        onNotice(
          `That isn't a link to one of ${repo}'s issues: drag an issue's card from the backlog, or its link.`,
        );
        return;
      }
      if (cards.some((c) => c.number === number && sameRepo(c.repo, repo))) return;
      act({ action: "start", number, mode: "brainstorm" });
    },
  );

  const issueUrl = (number: number) => `${github}/${repo}/issues/${number}`;
  const rows: Record<QueueTab, Row[]> = {
    backlog: shown.map((i) => {
      // A parent with open sub-issues is laid out with them ("plan").
      const parent = !!i.subIssues;
      return {
        key: `${i.number}`,
        number: i.number,
        title: i.title,
        href: i.url,
        meta: i.subIssues ? `${plural(i.subIssues, "sub-issue")} · start lays them out` : "",
        drag: dragOf(ISSUE_TYPE, i.number, i.url),
        actions: [
          {
            label: "Start",
            aria: `Start #${i.number}`,
            icon: <Icon.Play size={11} />,
            run: () => act({ action: parent ? "plan" : "start", number: i.number, ...picked }),
            disabled: off,
          },
          {
            label: "After…",
            aria: `Queue #${i.number} after…`,
            after: (after: number) =>
              act({ action: parent ? "plan" : "queue", number: i.number, after, ...picked }),
            disabled: off,
          },
          ...(brainstorms
            ? [
                {
                  label: "Brainstorm",
                  aria: `Brainstorm #${i.number}`,
                  run: () => act({ action: "start", number: i.number, mode: "brainstorm" }),
                  disabled: off,
                },
              ]
            : []),
        ],
      };
    }),
    brainstorm: cards.map((c) => {
      const can = !blocked && !busy && movable(c);
      const status = c.sending ?? (c.task ? STATE_NAMES[c.task.state] : "");
      const time = !c.sending && c.task ? when(c.task, now) : "";
      return {
        key: c.key,
        number: c.number,
        title: c.title,
        href: issueUrl(c.number),
        meta: [status, time].filter(Boolean).join(" · "),
        drag:
          !blocked && movable(c)
            ? dragOf(BRAINSTORM_TYPE, c.number, issueUrl(c.number))
            : undefined,
        actions: [
          {
            label: "Start work",
            aria: `Start work on #${c.number}`,
            icon: <Icon.Play size={11} />,
            run: () => act({ action: "start", number: c.number }),
            disabled: !can,
          },
          {
            label: "After…",
            aria: `Queue #${c.number} after…`,
            after: (after: number) => act({ action: "queue", number: c.number, after }),
            disabled: !can,
          },
          {
            label: "Stop",
            aria: `Stop #${c.number}'s brainstorm`,
            run: () => act({ action: "stop", number: c.number }),
            disabled: !can,
          },
        ],
      };
    }),
    waiting: waiting.map((t) => ({
      key: t.key,
      number: t.number!,
      title: t.title,
      href: issueUrl(t.number!),
      meta: `after ${issueList(t.waitingFor ?? [])}`,
      actions: [
        {
          label: "Start now",
          aria: `Start #${t.number} now`,
          icon: <Icon.Play size={11} />,
          // Its wait's mode, as moving it keeps.
          run: () => act({ action: "start", number: t.number! }),
          disabled: off,
        },
        {
          label: "After…",
          aria: `Queue #${t.number} after…`,
          after: (after: number) => act({ action: "queue", number: t.number!, after }),
          disabled: off,
        },
        {
          label: "Remove wait",
          aria: `Remove #${t.number}'s wait`,
          run: () => act({ action: "dequeue", number: t.number! }),
          disabled: off,
        },
      ],
    })),
    answers: answering.map((t) => {
      const count = t.questions?.items?.length;
      return {
        key: t.key,
        number: t.number!,
        title: t.title,
        href: issueUrl(t.number!),
        meta: count ? `${plural(count, "open question")}` : "Open questions",
        drag: blocked ? undefined : dragOf(ISSUE_TYPE, t.number!, issueUrl(t.number!)),
        actions: [
          {
            label: "Answer",
            aria: `Answer #${t.number} and start it`,
            run: () => act({ action: "start", number: t.number!, ...picked }),
            disabled: off,
          },
          {
            label: "Answer then queue…",
            aria: `Answer #${t.number} then queue it after…`,
            after: (after: number) => act({ action: "queue", number: t.number!, after, ...picked }),
            disabled: off,
          },
        ],
      };
    }),
  };

  const LISTS: Record<QueueTab, { label: string; empty: string }> = {
    backlog: {
      label: "Open issues with no task",
      empty: filter ? "No open issue matches." : "No open issue left to start.",
    },
    brainstorm: { label: "Issues being brainstormed", empty: "No brainstorm going on." },
    waiting: { label: "Waiting issues", empty: "No issue waits for another." },
    answers: { label: "Issues waiting for answers", empty: "No issue waits for your answers." },
  };

  const button = (row: Row, a: RowAction, first: boolean, inMenu = false) => {
    const queue = !!a.after;
    return (
      <Button
        key={a.label}
        size={touch ? "touch" : "small"}
        variant={first || inMenu ? "secondary" : "ghost"}
        class={inMenu ? styles.menuButton : undefined}
        icon={a.icon}
        aria-label={a.aria}
        aria-haspopup={queue ? "dialog" : undefined}
        disabled={a.disabled}
        onClick={() => {
          if (!a.after) return a.run?.();
          // A phone's menu goes: the dialog takes its place.
          setMenu(null);
          setChoosing({ number: row.number, queue: a.after });
        }}
      >
        {a.label}
      </Button>
    );
  };

  const card = (row: Row) => {
    const name = row.title ?? `Issue #${row.number}`;
    const text = (
      <div class={styles.text}>
        {row.href ? (
          <a class={styles.name} href={row.href} target="_blank" rel="noreferrer">
            <span class={styles.ref}>#{row.number}</span> <span title={name}>{name}</span>
          </a>
        ) : (
          <span class={styles.name}>
            <span class={styles.ref}>#{row.number}</span> <span title={name}>{name}</span>
          </span>
        )}
        {row.meta && <span class={styles.meta}>{row.meta}</span>}
      </div>
    );
    if (touch) {
      const [first, ...rest] = row.actions;
      const opened = menu === row.key;
      return (
        <li key={row.key} class={styles.row}>
          {text}
          {button(row, first, true)}
          {rest.length > 0 && (
            <IconButton
              variant="ghost"
              size="touch"
              label={`More for #${row.number}: ${rest.map((a) => a.label.toLowerCase()).join(", ")}`}
              aria-haspopup="dialog"
              aria-expanded={opened}
              icon={<Icon.More size={18} />}
              onClick={() => setMenu(row.key)}
            />
          )}
          {opened && (
            <Sheet title={`#${row.number} ${name}`} onClose={() => setMenu(null)}>
              <div class={styles.menu}>{rest.map((a) => button(row, a, false, true))}</div>
            </Sheet>
          )}
        </li>
      );
    }
    return (
      <li
        key={row.key}
        class={`${styles.item} ${row.drag ? styles.draggable : ""} ${dragging === row.key ? styles.ghosted : ""}`}
        draggable={!!row.drag}
        onDragStart={(e) => {
          if (!row.drag) return;
          row.drag(e);
          setDragging(row.key);
        }}
        onDragEnd={() => {
          dragEnded();
          setDragging(null);
        }}
      >
        <span class={styles.grip} aria-hidden="true">
          {row.drag && <Icon.Grip size={14} />}
        </span>
        {text}
        <div class={styles.buttons}>{row.actions.map((a, i) => button(row, a, i === 0))}</div>
      </li>
    );
  };

  const counts: Record<QueueTab, number> = {
    backlog: issues.length,
    brainstorm: cards.length,
    waiting: waiting.length,
    answers: answering.length,
  };
  const panelId = `queue-${repo.replace(/\W/g, "-")}`;
  const list = LISTS[tab];
  const zone = tab === "backlog" ? stopZone : tab === "brainstorm" ? brainstormZone : null;
  const picking = (id: QueueTab) => {
    onTab(id);
    setOpen(true);
  };

  return (
    <section
      class={`${styles.queue} ${touch ? styles.sheet : ""} ${touch && !open ? styles.closed : ""}`}
      aria-label="Work queue"
    >
      {touch && (
        <button
          type="button"
          class={styles.handle}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "Collapse the work queue" : "Expand the work queue"}
          onClick={() => setOpen(!open)}
        >
          <span />
        </button>
      )}
      <Tabs
        label="Work queue"
        class={styles.tabs}
        selected={tab}
        onSelect={picking}
        panel={panelId}
        tabs={[
          {
            id: "backlog",
            label: "Backlog",
            count: counts.backlog,
            attrs: { ...stopZone.handlers, class: stopZone.over ? styles.over : undefined },
          },
          {
            id: "brainstorm",
            label: "Brainstorm",
            count: counts.brainstorm,
            attrs: {
              ...brainstormZone.handlers,
              class: brainstormZone.over ? styles.over : undefined,
            },
          },
          { id: "waiting", label: "Waiting", count: counts.waiting },
          { id: "answers", label: "Answers", count: counts.answers, hot: counts.answers > 0 },
        ]}
      />
      <div
        id={panelId}
        role="tabpanel"
        aria-label={list.label}
        class={`${styles.panel} ${zone?.over ? styles.over : ""}`}
        hidden={touch && !open}
        {...(zone?.handlers ?? {})}
      >
        {said && (
          <Notice tone={said.failed ? "err" : "done"} class={styles.notice}>
            {said.text}
          </Notice>
        )}
        {blocked && (
          <Notice tone="err" class={styles.notice}>
            {repo}'s .deckhand.yaml has errors: nothing starts until they are fixed.
          </Notice>
        )}
        {tab === "backlog" && work.error && !backlog && (
          <Notice tone="err" class={styles.notice}>
            Can't read the issues ({work.error}).
          </Notice>
        )}
        {tab === "backlog" && !touch && backlog && issues.length > 0 && (
          <Field
            class={styles.filter}
            label="Filter the backlog"
            hideLabel
            size="small"
            lead={<Icon.Search size={14} />}
            placeholder={`Filter ${plural(issues.length, "open issue")}`}
            value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        )}
        {tab === "backlog" && !backlog && !work.error ? (
          <p class={styles.empty}>Loading…</p>
        ) : (
          (tab !== "backlog" || backlog) && (
            <ul class={touch ? styles.rows : styles.list} aria-label={list.label}>
              {!rows[tab].length && <li class={styles.empty}>{list.empty}</li>}
              {rows[tab].map(card)}
            </ul>
          )
        )}
      </div>
      {!touch && <p class={styles.hint}>{HINTS[tab]}</p>}
      {choosing && (
        <Chooser
          number={choosing.number}
          targets={targets}
          disabled={busy}
          onQueue={choosing.queue}
          onClose={() => setChoosing(null)}
        />
      )}
    </section>
  );
}
