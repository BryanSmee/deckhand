// The board's work queue: a panel of tabs beside the graph (a bottom sheet on a phone).
// Backlog: the repo's open issues with nothing live, to start, queue after another or
// brainstorm. Brainstorm: the issues being brainstormed, to start work on, queue or stop.
// Waiting: those waiting for others, to start now, queue after another or take out of their
// wait. Answers: those waiting for answers, which a start or a queue asks first. Queued: the
// tasks waiting for a slot, in the order they start (the run order, listener/order.mjs): drag
// one above or below another, or Run next, Move up and Move down; an issue's can also wait for
// another issue instead (Queue after…) or go back to the backlog. Each card has a button for
// each drag (on a phone, its first one and a menu for the rest), so phones and keyboards can
// do the same. The drags onto the graph are the board's (Board.tsx); the tabs take drops too:
// a card on Brainstorm brainstorms it, a brainstorm on Backlog stops it, a Queued card there
// goes back to the backlog.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useCan } from "./access";
import type { WorkAreaState } from "./api";
import { BacklogFilter, matchesText, narrowBacklog, Swatch } from "./BacklogFilter";
import { Chooser, type Target } from "./Chooser";
import {
  BRAINSTORM_TYPE,
  dragEnded,
  dragOf,
  droppedIssue,
  ISSUE_TYPE,
  LINK_TYPES,
  QUEUED_TYPE,
  queuedDrag,
} from "./dnd";
import { issueList, sameRepo, STATE_NAMES, when } from "./format";
import {
  alreadyThere,
  type BrainstormCard,
  ordinal,
  reorderable,
  unqueueable,
  waitable,
} from "./graphModel";
import { typesOf, useDropZone } from "./hooks";
// `tr`: t() where a task is called `t`.
import { locale, t as tr } from "./i18n";
import type { Plain } from "./locales";
import { useBacklogLabels, usePref } from "./prefs";
import type { BacklogLabel, OrderMove, Task, WorkAction } from "./types";
import { AutoMark } from "./ui/AutoMark";
import { Button, IconButton } from "./ui/Button";
import * as Icon from "./ui/icons";
import { Sheet } from "./ui/Sheet";
import { Notice } from "./ui/Surface";
import { Tabs } from "./ui/Tabs";
import styles from "./WorkQueue.module.css";

export type QueueTab = "backlog" | "brainstorm" | "waiting" | "answers" | "queued";

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
  // Its icon alone, `label` its name: beside the first button on a phone too, not in the menu.
  iconOnly?: boolean;
  // Its key on the board, for the card selected ("Queue after…" is always Q).
  shortcut?: "start" | "brainstorm";
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
  // Picked by auto-pickup: its mark leads the meta line.
  auto?: boolean;
  // A backlog issue's labels: a line of their own under the meta line, on a wide screen.
  labels?: BacklogLabel[];
  // Its drag, if it has one: the card's payload.
  drag?: (e: DragEvent) => void;
  // A Queued card: dropped above or below another, it moves there in the run order.
  queued?: boolean;
  actions: RowAction[];
}

// A tab's hint: what its cards' drags do (its key: read when shown).
const HINTS: Record<QueueTab, Plain> = {
  backlog: "queue.hintBacklog",
  brainstorm: "queue.hintBrainstorm",
  waiting: "queue.hintWaiting",
  answers: "queue.hintAnswers",
  queued: "queue.hintQueued",
};

interface Props {
  repo: string;
  work: WorkAreaState;
  // The Brainstorm tab's cards, the waiting issues, those waiting for answers.
  cards: BrainstormCard[];
  waiting: Task[];
  answering: Task[];
  // The repo's tasks waiting for a slot, in run order (graphModel.ts inLine()), and their move:
  // `moving` while one is on its way.
  line: Task[];
  // Every repo's, as `line`: a drop where a card is already changes nothing.
  everyLine: Task[];
  onMove: (move: OrderMove) => void;
  moving: boolean;
  // The task already next among every repo's work runs (graphModel.ts nextInLine()).
  nextKey: string | null;
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
  line,
  everyLine,
  onMove,
  moving,
  nextKey,
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
  // A Queued card dragged over another: where it would go, above or below it.
  const [dropAt, setDropAt] = useState<{ key: string; above: boolean } | null>(null);
  // The Backlog's filters (BacklogFilter.tsx): its text, then its labels (this repo's) and
  // "Hide sub-issues" (every repo's), kept in this browser.
  const [filter, setFilter] = useState("");
  const [ticked, setTicked] = useBacklogLabels(repo);
  const [hideSubIssues, setHideSubIssues] = usePref("hideSubIssues");
  // A phone's sheet: open, or its tabs alone.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setChoosing(null);
    setMenu(null);
    setFilter("");
  }, [repo, tab]);

  const { backlog, busy } = work;
  const blocked = !!backlog?.errors;
  // What the user may do here (access.ts): the actions they may not aren't offered.
  const can = useCan();
  const starts = (mode: string | null | undefined) => can.start(repo, mode || "work");
  const manages = can.repo(repo, "runs:manage");
  const only = (ok: boolean, ...actions: RowAction[]) => (ok ? actions : []);
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
  // What the labels and the toggle leave (the tab's count), then the text.
  const narrowed = narrowBacklog(issues, ticked, hideSubIssues);
  const shown = narrowed.filter((i) => matchesText(i, filter));

  // A brainstorm's card let go on Backlog: it stops. A Queued card: it leaves the queue.
  const stopZone = useDropZone(
    (e) =>
      !blocked &&
      typesOf(e).some(
        (t) => (t === BRAINSTORM_TYPE && starts("stop")) || (t === QUEUED_TYPE && manages),
      ),
    (e) => {
      const key = e.dataTransfer?.getData(QUEUED_TYPE);
      if (key) {
        const t = line.find((t) => t.key === key);
        if (t && unqueueable(t) && !busy) act({ action: "cancel", number: t.number! });
        return;
      }
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
        starts("brainstorm") &&
        !types.includes(BRAINSTORM_TYPE) &&
        types.some((t) => [ISSUE_TYPE, ...LINK_TYPES].includes(t))
      );
    },
    (e) => {
      const number = droppedIssue(e.dataTransfer, [ISSUE_TYPE], github, repo);
      if (!number) {
        onNotice(tr("queue.notIssueLink", { repo }));
        return;
      }
      if (cards.some((c) => c.number === number && sameRepo(c.repo, repo))) return;
      act({ action: "start", number, mode: "brainstorm" });
    },
  );

  const issueUrl = (number: number) => `${github}/${repo}/issues/${number}`;
  const taskUrl = (t: Task) =>
    `${github}/${repo}/${t.kind === "pr" ? "pull" : t.kind === "discussion" ? "discussions" : "issues"}/${t.number}`;

  // The cards that move, and where a move puts one: up right before the one above, down right
  // after the one below (another repo's tasks between them move past it), Run next first.
  const movers = line.filter(reorderable);
  const move = (m: OrderMove) => {
    onNotice(null);
    onMove(m);
  };
  const queuedActions = (t: Task): RowAction[] => {
    const i = movers.indexOf(t);
    const still = moving || blocked;
    // First of the work runs of every repo shown: Run next has nothing to pass.
    const next = t.key === nextKey;
    // Those that start first (a mode apart from work's) don't move in line, but may leave it.
    const moves: RowAction[] =
      i < 0 || !manages
        ? []
        : [
            {
              label: tr("queue.runNext"),
              shortcut: "start",
              aria: tr("queue.runNextAria", { number: t.number! }),
              // A phone's row: three icons leave its title some room.
              iconOnly: touch,
              icon: touch ? <Icon.ToTop size={16} /> : <Icon.Play size={11} />,
              run: () => move({ key: t.key, first: true }),
              disabled: still || next,
            },
            {
              label: tr("queue.moveUp"),
              aria: tr("queue.moveUpAria", { number: t.number! }),
              iconOnly: true,
              icon: <Icon.ChevronUp size={touch ? 18 : 14} />,
              run: () => move({ key: t.key, before: movers[i - 1].key }),
              disabled: still || i === 0,
            },
            {
              label: tr("queue.moveDown"),
              aria: tr("queue.moveDownAria", { number: t.number! }),
              iconOnly: true,
              icon: <Icon.ChevronDown size={touch ? 18 : 14} />,
              run: () => move({ key: t.key, after: movers[i + 1].key }),
              disabled: still || i === movers.length - 1,
            },
          ];
    return [
      ...moves,
      // An issue's: it leaves the queue, to wait for another issue or for nothing.
      ...(waitable(t) && starts(t.mode)
        ? [
            {
              label: tr("queue.after"),
              aria: tr("queue.afterAria", { number: t.number! }),
              after: (after: number) => act({ action: "queue", number: t.number!, after }),
              disabled: still || busy,
            },
          ]
        : []),
      ...(unqueueable(t) && manages
        ? [
            {
              label: tr("queue.toBacklog"),
              aria: tr("queue.toBacklogAria", { number: t.number! }),
              // An icon beside the others on a wide screen, the row on one line; in the menu on
              // a phone.
              iconOnly: !touch,
              icon: touch ? undefined : <Icon.Close size={14} />,
              run: () => act({ action: "cancel", number: t.number! }),
              disabled: still || busy,
            },
          ]
        : []),
    ];
  };

  // A Queued card let go over `onto`: above it, right before it; below it, right after it.
  // Where it is already, nothing.
  const dropOnto = (key: string, onto: Task, above: boolean) => {
    const dragged = line.find((t) => t.key === key);
    if (key === onto.key || !dragged || !reorderable(dragged) || !reorderable(onto)) return;
    if (alreadyThere(everyLine, key, onto, above)) return;
    move(above ? { key, before: onto.key } : { key, after: onto.key });
  };
  const queuedRows: Row[] = line.map((t) => {
    const mode = t.mode && t.mode !== "work" ? t.mode : null;
    const first = t.startsFirst ? tr("queue.startsFirst") : null;
    const drags = !blocked && !moving && manages && (reorderable(t) || unqueueable(t));
    return {
      key: t.key,
      number: t.number!,
      title: t.title,
      href: taskUrl(t),
      meta: [tr("queue.inLine", { position: ordinal(t.position!) }), mode, first]
        .filter(Boolean)
        .join(" · "),
      auto: t.autoPickup,
      queued: true,
      drag: drags ? queuedDrag(t.key, t.number!) : undefined,
      actions: queuedActions(t),
    };
  });

  const rows: Record<QueueTab, Row[]> = {
    queued: queuedRows,
    backlog: shown.map((i) => {
      // A parent with open sub-issues is laid out with them ("plan").
      const parent = !!i.subIssues;
      return {
        key: `${i.number}`,
        number: i.number,
        title: i.title,
        href: i.url,
        meta: i.subIssues ? tr("queue.subIssues", { count: i.subIssues }) : "",
        labels: i.labels,
        drag:
          starts(picked.mode) || (brainstorms && starts("brainstorm"))
            ? dragOf(ISSUE_TYPE, i.number, i.url, {
                status: tr("queue.dragBacklog"),
                title: i.title ?? "",
              })
            : undefined,
        actions: [
          ...only(
            starts(picked.mode),
            {
              label: tr("queue.start"),
              shortcut: "start",
              aria: tr("queue.startAria", { number: i.number }),
              icon: <Icon.Play size={11} />,
              run: () => act({ action: parent ? "plan" : "start", number: i.number, ...picked }),
              disabled: off,
            },
            {
              label: tr("queue.after"),
              aria: tr("queue.afterAria", { number: i.number }),
              after: (after: number) =>
                act({ action: parent ? "plan" : "queue", number: i.number, after, ...picked }),
              disabled: off,
            },
          ),
          ...(brainstorms && starts("brainstorm")
            ? [
                {
                  label: tr("queue.brainstormAction"),
                  shortcut: "brainstorm" as const,
                  aria: tr("queue.brainstormAria", { number: i.number }),
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
      const status = c.sending ?? (c.task ? tr(STATE_NAMES[c.task.state]) : "");
      const time = !c.sending && c.task ? when(c.task, now) : "";
      return {
        key: c.key,
        number: c.number,
        title: c.title,
        href: issueUrl(c.number),
        meta: [status, time].filter(Boolean).join(" · "),
        drag:
          !blocked && movable(c) && (starts("work") || starts("stop"))
            ? dragOf(BRAINSTORM_TYPE, c.number, issueUrl(c.number), {
                status: status || tr(STATE_NAMES.brainstorm),
                title: c.title ?? "",
              })
            : undefined,
        actions: [
          ...only(
            starts("work"),
            {
              label: tr("queue.startWork"),
              shortcut: "start",
              aria: tr("queue.startWorkAria", { number: c.number }),
              icon: <Icon.Play size={11} />,
              run: () => act({ action: "start", number: c.number }),
              disabled: !can,
            },
            {
              label: tr("queue.after"),
              aria: tr("queue.afterAria", { number: c.number }),
              after: (after: number) => act({ action: "queue", number: c.number, after }),
              disabled: !can,
            },
          ),
          ...only(starts("stop"), {
            label: tr("queue.stop"),
            aria: tr("queue.stopAria", { number: c.number }),
            run: () => act({ action: "stop", number: c.number }),
            disabled: !can,
          }),
        ],
      };
    }),
    waiting: waiting.map((t) => ({
      key: t.key,
      number: t.number!,
      title: t.title,
      href: issueUrl(t.number!),
      meta: tr("when.after", { issues: issueList(t.waitingFor ?? []) }),
      actions: [
        // Its wait's mode, as moving it keeps.
        ...only(
          starts(t.mode),
          {
            label: tr("queue.startNow"),
            shortcut: "start",
            aria: tr("queue.startNowAria", { number: t.number! }),
            icon: <Icon.Play size={11} />,
            run: () => act({ action: "start", number: t.number! }),
            disabled: off,
          },
          {
            label: tr("queue.after"),
            aria: tr("queue.afterAria", { number: t.number! }),
            after: (after: number) => act({ action: "queue", number: t.number!, after }),
            disabled: off,
          },
        ),
        ...only(manages, {
          label: tr("queue.removeWait"),
          aria: tr("queue.removeWaitAria", { number: t.number! }),
          run: () => act({ action: "dequeue", number: t.number! }),
          disabled: off,
        }),
      ],
    })),
    answers: answering.map((t) => {
      const count = t.questions?.items?.length;
      return {
        key: t.key,
        number: t.number!,
        title: t.title,
        href: issueUrl(t.number!),
        meta: count ? tr("queue.openQuestions", { count }) : tr("queue.openQuestionsUncounted"),
        drag:
          blocked || !starts(picked.mode)
            ? undefined
            : dragOf(ISSUE_TYPE, t.number!, issueUrl(t.number!), {
                status: tr("queue.dragAnswer"),
                title: t.title ?? "",
              }),
        actions: only(
          starts(picked.mode),
          {
            label: tr("queue.answer"),
            shortcut: "start",
            aria: tr("queue.answerAria", { number: t.number! }),
            run: () => act({ action: "start", number: t.number!, ...picked }),
            disabled: off,
          },
          {
            label: tr("queue.answerQueue"),
            aria: tr("queue.answerQueueAria", { number: t.number! }),
            after: (after: number) => act({ action: "queue", number: t.number!, after, ...picked }),
            disabled: off,
          },
        ),
      };
    }),
  };

  // The tab's hint says what its drags do: not when none of its cards drags (access.ts).
  // An empty tab: whether its cards would drag, as each tab's rows decide it.
  const drags: Record<QueueTab, boolean> = {
    backlog: starts(picked.mode),
    answers: starts(picked.mode),
    brainstorm: starts("work") || starts("stop"),
    waiting: starts("work") || manages,
    queued: manages,
  };
  const hinted = rows[tab].length ? rows[tab].some((r) => r.drag) : drags[tab];

  const LISTS: Record<QueueTab, { label: Plain; empty: Plain }> = {
    backlog: {
      label: "queue.backlogList",
      // Its filters left nothing out of open issues.
      empty: issues.length ? "queue.backlogNoMatch" : "queue.backlogEmpty",
    },
    brainstorm: { label: "queue.brainstormList", empty: "queue.brainstormEmpty" },
    waiting: { label: "queue.waitingList", empty: "queue.waitingEmpty" },
    answers: { label: "queue.answersList", empty: "queue.answersEmpty" },
    queued: { label: "queue.queuedList", empty: "queue.queuedEmpty" },
  };

  const button = (row: Row, a: RowAction, first: boolean, inMenu = false) => {
    const queue = !!a.after;
    const key = queue ? "queue" : a.shortcut;
    if (a.iconOnly) {
      return (
        <IconButton
          key={a.label}
          size={touch ? "touch" : "small"}
          variant="ghost"
          label={a.aria ?? a.label}
          icon={a.icon}
          disabled={a.disabled}
          onClick={() => a.run?.()}
        />
      );
    }
    return (
      <Button
        key={a.label}
        data-action={key}
        shortcut={key}
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

  // A Queued card takes another one: the top half of it above, the bottom half below.
  const queuedDrop = (row: Row) => {
    const onto = line.find((t) => t.key === row.key);
    const above = (e: DragEvent) => {
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    };
    const takes = (e: DragEvent) => !!onto && reorderable(onto) && typesOf(e).includes(QUEUED_TYPE);
    return {
      onDragOver: (e: DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const up = above(e);
        if (dropAt?.key !== row.key || dropAt.above !== up) setDropAt({ key: row.key, above: up });
      },
      onDragLeave: (e: DragEvent) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !(e.currentTarget as Node).contains(to)) setDropAt(null);
      },
      onDrop: (e: DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        setDropAt(null);
        const key = e.dataTransfer?.getData(QUEUED_TYPE);
        if (key && onto) dropOnto(key, onto, above(e));
      },
    };
  };

  const card = (row: Row) => {
    const name = row.title ?? tr("queue.untitled", { number: row.number });
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
        {(row.meta || row.auto) && (
          <span class={styles.meta}>
            {row.auto && <AutoMark class={styles.auto} />}
            {row.meta}
          </span>
        )}
        {!touch && !!row.labels?.length && (
          <span class={styles.labels}>
            {row.labels.map((l) => (
              <span key={l.name} class={styles.label}>
                <Swatch color={l.color} />
                {l.name}
              </span>
            ))}
          </span>
        )}
      </div>
    );
    if (touch) {
      const [first, ...others] = row.actions;
      const inline = others.filter((a) => a.iconOnly);
      const rest = others.filter((a) => !a.iconOnly);
      const opened = menu === row.key;
      return (
        <li key={row.key} class={styles.row} data-card data-number={row.number}>
          {text}
          {first && button(row, first, !first.iconOnly)}
          {inline.map((a) => button(row, a, false))}
          {rest.length > 0 && (
            <IconButton
              variant="ghost"
              size="touch"
              label={tr("queue.more", {
                number: row.number,
                // The page's language's rules, not the browser's default (Turkish İ).
                actions: rest
                  .map((a) => a.label.toLocaleLowerCase(locale()))
                  .join(tr("list.comma")),
              })}
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
        data-card
        data-number={row.number}
        class={`${styles.item} ${row.drag ? styles.draggable : ""} ${dragging === row.key ? styles.ghosted : ""} ${dropAt?.key === row.key ? (dropAt.above ? styles.dropAbove : styles.dropBelow) : ""}`}
        draggable={!!row.drag}
        onDragStart={(e) => {
          if (!row.drag) return;
          row.drag(e);
          setDragging(row.key);
        }}
        onDragEnd={() => {
          dragEnded();
          setDragging(null);
          setDropAt(null);
        }}
        {...(row.queued && queuedDrop(row))}
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
    backlog: narrowed.length,
    brainstorm: cards.length,
    waiting: waiting.length,
    answers: answering.length,
    queued: line.length,
  };
  // On a phone, five tabs fit in a row only without their zeros.
  const count = (id: QueueTab) => (touch && !counts[id] ? undefined : counts[id]);
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
      aria-label={tr("queue.label")}
    >
      {touch && (
        <button
          type="button"
          class={styles.handle}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={tr(open ? "queue.collapse" : "queue.expand")}
          onClick={() => setOpen(!open)}
        >
          <span />
        </button>
      )}
      <Tabs
        label={tr("queue.label")}
        class={styles.tabs}
        selected={tab}
        onSelect={picking}
        panel={panelId}
        tabs={[
          {
            id: "backlog",
            label: tr("queue.backlog"),
            count: count("backlog"),
            attrs: { ...stopZone.handlers, class: stopZone.over ? styles.over : undefined },
          },
          {
            id: "brainstorm",
            label: tr("queue.brainstorm"),
            count: count("brainstorm"),
            attrs: {
              ...brainstormZone.handlers,
              class: brainstormZone.over ? styles.over : undefined,
            },
          },
          { id: "waiting", label: tr("queue.waiting"), count: count("waiting") },
          {
            id: "answers",
            label: tr("queue.answers"),
            count: count("answers"),
            hot: counts.answers > 0,
          },
          { id: "queued", label: tr("queue.queued"), count: count("queued") },
        ]}
      />
      <div
        id={panelId}
        role="tabpanel"
        aria-label={tr(list.label)}
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
            {tr("queue.configErrors", { repo })}
          </Notice>
        )}
        {tab === "backlog" && work.error && !backlog && (
          <Notice tone="err" class={styles.notice}>
            {tr("queue.unreadable", { error: work.error })}
          </Notice>
        )}
        {tab === "backlog" && backlog && issues.length > 0 && (
          <BacklogFilter
            issues={issues}
            count={narrowed.length}
            text={filter}
            onText={setFilter}
            ticked={ticked}
            onTicked={setTicked}
            hideSubIssues={hideSubIssues}
            onHideSubIssues={setHideSubIssues}
            touch={touch}
          />
        )}
        {tab === "backlog" && !backlog && !work.error ? (
          <p class={styles.empty}>{tr("queue.loading")}</p>
        ) : (
          (tab !== "backlog" || backlog) && (
            <ul class={touch ? styles.rows : styles.list} aria-label={tr(list.label)}>
              {!rows[tab].length && <li class={styles.empty}>{tr(list.empty)}</li>}
              {rows[tab].map(card)}
            </ul>
          )
        )}
      </div>
      {!touch && hinted && <p class={styles.hint}>{tr(HINTS[tab])}</p>}
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
