// A run's log, folded into its sections (logModel.ts): setup, the image's build (its steps,
// cached ones together, a failed one open), the work (messages as text, tool calls folded,
// a failed one open) and the pushes. A section with an error opens by itself (unless
// Preferences says not to); the others start folded, except the work. A toolbar searches it
// (the folds holding the matches open), filters it, folds it all and copies or downloads it; a phone has an action bar instead,
// and its search replaces the page's header. A live run's log follows its end until the
// reader scrolls up (from the start, unless Preferences says not to); Latest brings it back.
// Long lines wrap, or scroll sideways (Preferences). Its shortcuts: F searches, Enter and Shift
// Enter go through the matches, E and Shift E fold it all, X and Shift X go through the errors,
// L follows it live, Ctrl Shift C copies it.
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { number, t, tx } from "./i18n";
import { useShortcuts, withKey } from "./keys";
import { copyText, downloadText } from "./logExport";
import {
  cachedLine,
  count,
  failuresFail,
  type Filter,
  isError,
  type Item,
  type LogSection,
  logSections,
  matcher,
  PHASE_TITLES,
  plainText,
  resultTitle,
  search,
  shortDuration,
  shown,
  type Step,
  stepStatus,
  type Timing,
  timeLabel,
  toolLabel,
} from "./logModel";
import type { Plain } from "./locales";
import { getPref, usePref } from "./prefs";
import type { Entry, Run } from "./types";
import { Button, IconButton } from "./ui/Button";
import { Segmented } from "./ui/Choice";
import { Field } from "./ui/Field";
import { FilterChip } from "./ui/FilterChip";
import { Fold } from "./ui/Fold";
import * as Icon from "./ui/icons";
import { StatusBadge, StatusDot } from "./ui/Status";
import styles from "./Log.module.css";

interface Props {
  run: Run;
  // Its log so far (api.ts useRunLog(), which the page reads: its More menu copies it too).
  entries: Entry[];
  now: number;
  // A phone's: the action bar, and a search that takes the page's header.
  touch?: boolean;
  searching?: boolean;
  onSearching?: (on: boolean) => void;
}

const FILTERS: { value: Filter; label: Plain; phone: Plain }[] = [
  { value: "all", label: "log.filterAll", phone: "log.filterAllPhone" },
  { value: "messages", label: "log.filterMessages", phone: "log.filterMessages" },
  { value: "tools", label: "log.filterTools", phone: "log.filterToolsPhone" },
  { value: "errors", label: "log.filterErrors", phone: "log.filterErrors" },
];

// What the highlighting reads: the query, where each field's matches start, the current one.
const Hits = createContext<{ query: string; starts: Map<string, number>; current: number }>({
  query: "",
  starts: new Map(),
  current: -1,
});

// Near enough to the end to keep following it.
const NEAR_END = 40;

export function Log({ run, entries, now, touch, searching, onSearching }: Props) {
  const live = run.status === "running";
  // A finished run's sections don't change with the clock.
  const end = live ? now : (run.finishedAt ?? now);
  const list = useMemo(
    () => logSections(entries, end, live),
    [entries, live ? end : run.finishedAt, live],
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [current, setCurrent] = useState(0);
  // Folds the reader opened or closed, then Expand all or Collapse all (null: neither).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<boolean | null>(null);
  // The error Next error went to: held open.
  const [focus, setFocus] = useState<string | null>(null);
  const [follow] = usePref("logFollow");
  const [openErrors] = usePref("logErrors");
  const [wrap] = usePref("logWrap");
  const [following, setFollowing] = useState(live && follow);
  // How the last Copy went, for a moment.
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const found = useMemo(() => search(list, query, filter), [list, query, filter]);
  const total = found.matches.length;
  const at = total ? Math.min(current, total - 1) : -1;
  const match = found.matches[at];
  const errors = list.flatMap((s) =>
    s.items.filter(isError).map((i) => ({ section: s.phase, item: i.id })),
  );
  const focused = errors.find((e) => e.item === focus);
  // The folds of the current match and of the error gone to stay open.
  const held = new Set([match?.section, match?.item, focused?.section, focus]);
  // What the reader did last wins, until the current match or the error gone to moves there.
  const isOpen = (id: string, fallback: boolean) =>
    overrides[id] ?? (held.has(id) || (query && found.hits.get(id) ? true : (all ?? fallback)));
  // The folds a match or an error moved to open, even those the reader closed.
  const reopen = (...ids: string[]) =>
    setOverrides((o) => {
      const next = { ...o };
      for (const id of ids) delete next[id];
      return next;
    });
  // Only what the reader did: the echo of an `open` set from here changes nothing.
  const toggle = (id: string, fallback: boolean) => (open: boolean) => {
    if (open !== isOpen(id, fallback)) setOverrides((o) => ({ ...o, [id]: open }));
  };

  const find = (q: string) => {
    setQuery(q);
    setCurrent(0);
    setOverrides({});
  };
  const step = (by: number) => {
    if (!total) return;
    const next = (at + by + total) % total;
    reopen(found.matches[next].section, found.matches[next].item);
    setCurrent(next);
  };
  // Done, or Escape: the search ends, its filter too.
  const endSearch = () => {
    find("");
    setFilter("all");
    onSearching?.(false);
  };
  const foldAll = (open: boolean) => {
    setOverrides({});
    setFocus(null);
    setAll(open);
  };
  const nextError = (by = 1) => {
    if (!errors.length) return;
    const i = errors.findIndex((e) => e.item === focus);
    // None gone to yet: the first one forwards, the last one back.
    const from = i < 0 ? (by > 0 ? -1 : 0) : i;
    const next = errors[(from + by + errors.length) % errors.length];
    reopen(next.section, next.item);
    setFocus(next.item);
  };

  // The page's scroller: the log follows its end there.
  const scroller = () => {
    for (let el = root.current?.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    }
    return (document.scrollingElement as HTMLElement | null) ?? null;
  };
  const toEnd = () => {
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
  };
  const latest = () => {
    toEnd();
    setFollowing(true);
  };
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () =>
      setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (live && following) toEnd();
  }, [entries, live, following]);
  // The current match, or the error gone to, in view.
  useEffect(() => {
    root.current?.querySelector("mark[data-current]")?.scrollIntoView?.({ block: "center" });
  }, [at, query, filter]);
  useEffect(() => {
    if (focus)
      root.current?.querySelector(`[data-item="${focus}"]`)?.scrollIntoView?.({ block: "center" });
  }, [focus]);

  const text = () => plainText(list);
  const copy = async () => {
    setCopied((await copyText(text())) ? "ok" : "failed");
    setTimeout(() => setCopied(null), 3000);
  };
  const download = () => downloadText(`${run.id}.txt`, text());

  useShortcuts({
    logSearch: () => {
      if (touch) return onSearching?.(true);
      root.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
    },
    match: (i) => (query && total ? step(i === 0 ? 1 : -1) : false),
    expand: () => foldAll(true),
    collapse: () => foldAll(false),
    error: (i) => (errors.length ? nextError(i === 0 ? 1 : -1) : false),
    follow: latest,
    copy: () => void copy(),
  });

  const visible = list.filter((s) => filter === "all" || s.items.some((i) => shown(i, filter)));
  const counter = query ? (total ? `${at + 1} / ${total}` : "0 / 0") : "";
  const searchBox = (
    <div class={styles.searchBox}>
      <Field
        label={t("log.search")}
        hideLabel
        placeholder={t("log.search")}
        type="search"
        size={touch ? "touch" : "small"}
        lead={<Icon.Search size={touch ? 18 : 14} />}
        value={query}
        autoFocus={touch}
        onInput={(e) => find((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          if (e.key === "Escape" && touch) endSearch();
        }}
        class={styles.searchField}
      />
      <span class={styles.trail}>
        {touch ? (
          query && (
            <IconButton
              variant="ghost"
              size="small"
              label={t("log.clearSearch")}
              icon={<Icon.Close size={16} />}
              onClick={() => find("")}
            />
          )
        ) : (
          <>
            <span class={styles.counter} aria-live="polite">
              {counter}
            </span>
            <IconButton
              variant="ghost"
              size="small"
              class={styles.tiny}
              label={t("log.previousMatch")}
              title={withKey(t("log.previousMatch"), "match", 1)}
              icon={<Icon.ChevronUp size={14} />}
              disabled={!total}
              onClick={() => step(-1)}
            />
            <IconButton
              variant="ghost"
              size="small"
              class={styles.tiny}
              label={t("log.nextMatch")}
              title={withKey(t("log.nextMatch"), "match", 0)}
              icon={<Icon.ChevronDown size={14} />}
              disabled={!total}
              onClick={() => step(1)}
            />
          </>
        )}
      </span>
    </div>
  );

  return (
    <div class={`${styles.wrap} ${wrap ? "" : styles.nowrap}`} ref={root}>
      {touch && searching ? (
        <div class={styles.phoneSearch}>
          <div class={styles.phoneSearchRow}>
            {searchBox}
            <Button variant="ghost" size="touch" onClick={endSearch}>
              {t("log.done")}
            </Button>
          </div>
          <div class={styles.chips} role="group" aria-label={t("log.searchIn")}>
            {FILTERS.map((f) => (
              <FilterChip
                key={f.value}
                pressed={filter === f.value}
                count={f.value === "errors" ? errors.length : undefined}
                onClick={() => setFilter(f.value)}
              >
                {t(f.phone)}
              </FilterChip>
            ))}
          </div>
        </div>
      ) : (
        !touch && (
          <div class={styles.toolbar}>
            {searchBox}
            <Segmented
              label={t("log.show")}
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({
                value: f.value,
                label: t(f.label),
                extra:
                  f.value === "errors" && errors.length ? (
                    <>
                      {" "}
                      <span class={styles.errCount}>{errors.length}</span>
                    </>
                  ) : undefined,
              }))}
            />
            <span class={styles.tools}>
              <Button variant="ghost" size="small" shortcut="expand" onClick={() => foldAll(true)}>
                {t("log.expandAll")}
              </Button>
              <Button
                variant="ghost"
                size="small"
                shortcut="collapse"
                onClick={() => foldAll(false)}
              >
                {t("log.collapseAll")}
              </Button>
              <IconButton
                variant="ghost"
                size="small"
                label={
                  copied === "ok"
                    ? t("log.copied")
                    : copied === "failed"
                      ? t("log.copyFailed")
                      : t("log.copy")
                }
                title={copied ? undefined : withKey(t("log.copy"), "copy")}
                class={copied === "failed" ? styles.copyFailed : undefined}
                icon={
                  copied === "ok" ? (
                    <Icon.Check size={15} />
                  ) : copied === "failed" ? (
                    <Icon.Alert size={15} />
                  ) : (
                    <Icon.Copy size={15} />
                  )
                }
                onClick={copy}
              />
              <IconButton
                variant="ghost"
                size="small"
                label={t("log.download")}
                icon={<Icon.Download size={15} />}
                onClick={download}
              />
            </span>
          </div>
        )
      )}

      <Hits.Provider value={{ query, starts: found.starts, current: at }}>
        <div
          class={styles.log}
          role="log"
          aria-label={query ? t("log.labelSearched", { query }) : t("log.label")}
          data-testid="log"
        >
          {visible.map((s) => (
            <SectionView
              key={s.phase}
              section={s}
              filter={filter}
              open={isOpen(s.phase, (openErrors && s.failures > 0) || s.phase === "work")}
              onToggle={toggle(s.phase, (openErrors && s.failures > 0) || s.phase === "work")}
              hits={query ? (found.hits.get(s.phase) ?? 0) : null}
              isOpen={isOpen}
              toggle={toggle}
            />
          ))}
          {!list.length && <p class={styles.empty}>{live ? t("log.starting") : t("log.empty")}</p>}
          {live && (
            <p class={styles.live}>
              <StatusDot state="running" />
              {following ? t("log.workingFollowing") : t("log.working")}
            </p>
          )}
        </div>
      </Hits.Provider>

      {!touch && live && !following && (
        <Button
          class={styles.follow}
          size="small"
          icon={<Icon.ArrowDown size={14} />}
          shortcut="follow"
          onClick={latest}
        >
          {t("log.latest")}
        </Button>
      )}

      {touch &&
        (searching ? (
          <nav class={styles.bar} aria-label={t("log.matchesBar")}>
            <IconButton
              size="touch"
              label={t("log.previousMatch")}
              icon={<Icon.ChevronUp size={20} />}
              disabled={!total}
              onClick={() => step(-1)}
            />
            <span class={styles.where} role="status">
              {query
                ? total
                  ? tx("log.matchOf", {
                      at: <b>{number(at + 1)}</b>,
                      total,
                      section: t(PHASE_TITLES[match.section]),
                    })
                  : t("log.noMatchBar")
                : t("log.search")}
            </span>
            <IconButton
              size="touch"
              label={t("log.nextMatch")}
              icon={<Icon.ChevronDown size={20} />}
              disabled={!total}
              onClick={() => step(1)}
            />
          </nav>
        ) : (
          <nav class={`${styles.bar} ${styles.actions}`} aria-label={t("log.actionsBar")}>
            <button type="button" onClick={() => onSearching?.(true)}>
              <Icon.Search size={20} />
              {t("log.searchButton")}
            </button>
            <button
              type="button"
              class={errors.length ? styles.hasErrors : ""}
              disabled={!errors.length}
              onClick={() => nextError()}
            >
              <Icon.Alert size={20} />
              {t("log.nextError")}
            </button>
            <button type="button" onClick={() => foldAll(false)}>
              <Icon.Expand size={20} />
              {t("log.foldAll")}
            </button>
            <button type="button" onClick={latest}>
              <Icon.ArrowDown size={20} />
              {t("log.latest")}
            </button>
          </nav>
        ))}
    </div>
  );
}

interface SectionProps {
  section: LogSection;
  filter: Filter;
  open: boolean;
  onToggle: (open: boolean) => void;
  // Its matches while searching, else null.
  hits: number | null;
  isOpen: (id: string, fallback: boolean) => boolean;
  toggle: (id: string, fallback: boolean) => (open: boolean) => void;
}

function SectionView({ section: s, filter, open, onToggle, hits, isOpen, toggle }: SectionProps) {
  const tone = s.failed ? "err" : s.current ? "run" : "done";
  // Its failures flag it only where they fail it: elsewhere, their count is plain text. A
  // section that failed otherwise (the agent ended in error) says so: its dot isn't alone.
  const flagged = failuresFail(s.phase) && s.failures > 0;
  const searchBadge = hits !== null ? styles.searchBadge : "";
  return (
    <Fold
      title={t(PHASE_TITLES[s.phase])}
      tone={tone}
      pulse={s.current}
      open={open}
      onToggle={onToggle}
      class={hits === 0 ? styles.missed : undefined}
      meta={
        <>
          {hits !== null ? (
            <span class={hits ? styles.hits : undefined}>
              {hits ? t("log.matches", { count: hits }) : t("log.noMatch")}
            </span>
          ) : (
            <span class={styles.counts}>{counts(s)}</span>
          )}
          {s.failures > 0 && !flagged && (
            // On a phone, hidden like the counts when a badge follows: the title keeps its room.
            <span class={s.failed ? styles.counts : searchBadge}>{failed(s)}</span>
          )}
          {(flagged || s.failed) && (
            <StatusBadge
              tone="err"
              label={flagged ? failed(s) : t("log.endedInError")}
              class={`${styles.badge} ${searchBadge}`}
            />
          )}
          {s.seconds !== null && <span class={styles.mono}>{shortDuration(s.seconds)}</span>}
        </>
      }
    >
      {s.items
        .filter((i) => shown(i, filter))
        .map((item) => (
          <ItemView key={item.id} item={item} isOpen={isOpen} toggle={toggle} />
        ))}
    </Fold>
  );
}

// "9 steps · 7 cached", "4 messages · 23 tool calls", "2 lines".
function counts(s: LogSection): string {
  if (s.phase === "image") {
    const steps = s.items.flatMap((i) =>
      i.kind === "step" ? [i.step] : i.kind === "cached" ? i.steps : [],
    );
    const cached = steps.filter((x) => x.status === "cached").length;
    return [
      t("log.steps", { count: steps.length }),
      cached ? t("log.cached", { count: cached }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const said = s.items.filter((i) => i.kind === "say").length;
  const tools = s.items.filter((i) => i.kind === "tool").length;
  const parts = [
    said ? t("log.messages", { count: said }) : "",
    tools ? t("log.toolCalls", { count: tools }) : "",
  ];
  if (!said && !tools) parts.push(t("log.lines", { count: s.items.length }));
  return parts.filter(Boolean).join(" · ");
}

function failed(s: LogSection): string {
  if (s.phase === "image") return t("log.failedSteps", { count: s.failures });
  return t("log.failedCommands", { count: s.failures });
}

// A field's text with its matches marked; the current one stands out.
function Hl({ text, field }: { text: string; field: string }) {
  const { query, starts, current } = useContext(Hits);
  const start = starts.get(field);
  if (!query || start === undefined) return <>{text}</>;
  // Found in the text as it is, as logModel.ts count() finds them: lowercasing may change
  // lengths ("İ").
  const parts: ComponentChildren[] = [];
  let from = 0;
  let n = start;
  for (const m of text.matchAll(matcher(query))) {
    parts.push(text.slice(from, m.index));
    const cur = n === current;
    parts.push(
      <mark key={n} class={cur ? styles.current : undefined} data-current={cur ? "" : undefined}>
        {m[0]}
      </mark>,
    );
    n++;
    from = m.index + m[0].length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export interface ItemProps {
  item: Item;
  isOpen: (id: string, fallback: boolean) => boolean;
  toggle: (id: string, fallback: boolean) => (open: boolean) => void;
}

// One item of a log: the chat's conversation (Conversation.tsx) shows them too.
export function ItemView({ item, isOpen, toggle }: ItemProps) {
  const f = (i: number) => `${item.id}:${i}`;
  switch (item.kind) {
    case "say":
      return (
        <p class={styles.say} data-item={item.id}>
          <Hl text={item.text} field={f(0)} />
        </p>
      );
    case "message":
      return (
        <div class={`${styles.line} ${styles.note}`} data-item={item.id}>
          <span class={styles.tag}>{t("log.tagYou")}</span>
          <span class={styles.text}>
            <Hl text={item.text} field={f(0)} />
          </span>
        </div>
      );
    case "note":
      return (
        <div class={`${styles.line} ${styles.note}`} data-item={item.id}>
          <span class={styles.tag}>›</span>
          <span>
            <Hl text={item.text} field={f(0)} />
          </span>
        </div>
      );
    case "raw":
      return (
        <div class={`${styles.line} ${styles.muted}`} data-item={item.id}>
          <span class={styles.tag} />
          <span class={styles.text}>
            <Hl text={item.text} field={f(0)} />
          </span>
        </div>
      );
    case "output":
      return (
        <pre class={`${styles.out} ${item.error ? styles.error : ""}`} data-item={item.id}>
          <Hl text={item.text || t("log.noOutput")} field={f(0)} />
        </pre>
      );
    case "result":
      return (
        <div class={`${styles.result} ${styles[item.status] ?? ""}`} data-item={item.id}>
          <strong>{resultTitle(item)}</strong>
          <Hl text={item.text} field={f(0)} />
        </div>
      );
    case "cached":
      return (
        <div class={`${styles.line} ${styles.muted}`} data-item={item.id}>
          <span class={styles.tag}>{t("log.tagBuild")}</span>
          <span class={styles.text}>
            <Hl text={cachedLine(item.steps)} field={f(0)} />
          </span>
        </div>
      );
    case "tool": {
      const error = item.outputs.some((o) => o.error);
      // Its parent's subscription redraws it when the preference changes.
      const opens = error && getPref("logErrors");
      const mcp = toolLabel(item.name);
      // logModel.ts fields(): an MCP call's name comes after its outputs.
      const tag = <ToolTag name={item.name} field={f(item.outputs.length + 1)} />;
      const short = mcp && <span class={styles.toolName}>{mcp.tool}</span>;
      if (!item.outputs.length)
        return (
          <TimedLine id={item.id} time={item.time} tag={tag}>
            {short}
            <Hl text={item.text} field={f(0)} />
          </TimedLine>
        );
      const lines = item.outputs.reduce((n, o) => n + o.text.split("\n").length, 0);
      return (
        <Sub
          id={item.id}
          error={error}
          open={isOpen(item.id, opens)}
          onToggle={toggle(item.id, opens)}
          tag={tag}
          head={
            <>
              {short}
              <Hl text={item.text || " "} field={f(0)} />
            </>
          }
          meta={
            <>
              {error ? t("log.failed") : t("log.lines", { count: lines })}
              {item.time && <Time time={item.time} />}
            </>
          }
        >
          {item.outputs.map((o, i) => (
            <pre key={i} class={`${styles.out} ${o.error ? styles.error : ""}`}>
              <Hl text={o.text || t("log.noOutput")} field={f(i + 1)} />
            </pre>
          ))}
        </Sub>
      );
    }
    case "step":
      return <StepView id={item.id} step={item.step} isOpen={isOpen} toggle={toggle} />;
  }
}

function StepView({
  id,
  step: s,
  isOpen,
  toggle,
}: { id: string; step: Step } & Omit<ItemProps, "item">) {
  const f = (i: number) => `${id}:${i}`;
  const error = s.status === "error";
  if (!s.output.length && !error)
    return (
      <TimedLine id={id} time={s.time} tag={<span class={styles.tag}>#{s.step}</span>}>
        <Hl text={s.name} field={f(0)} />
        {stepStatus(s) && <span class={styles.muted}> · {stepStatus(s)}</span>}
      </TimedLine>
    );
  const meta = error
    ? t("log.failed")
    : [
        t("log.lines", { count: s.output.length }),
        s.seconds !== null ? t("log.seconds", { s: s.seconds }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
  const fallback = (error && getPref("logErrors")) || s.status === "running";
  return (
    <Sub
      id={id}
      error={error}
      open={isOpen(id, fallback)}
      onToggle={toggle(id, fallback)}
      tag={<span class={styles.tag}>#{s.step}</span>}
      head={<Hl text={s.name} field={f(0)} />}
      meta={
        <>
          {meta}
          {s.time && <Time time={s.time} />}
        </>
      }
    >
      <pre class={`${styles.out} ${error ? styles.error : ""}`}>
        {s.output.map((line, i) => (
          <span key={i}>
            <Hl text={line} field={f(i + 1)} />
            {"\n"}
          </span>
        ))}
        {error && <Hl text={stepStatus(s)} field={f(s.output.length + 1)} />}
      </pre>
    </Sub>
  );
}

// A tool call or a build step with nothing under it: its tag and text, and its time when it
// is slow (logModel.ts timing()); the one in progress stands out.
function TimedLine({
  id,
  time,
  tag,
  children,
}: {
  id: string;
  time: Timing | null;
  tag: ComponentChildren;
  children: ComponentChildren;
}) {
  const running = time?.state === "running";
  return (
    <div
      class={`${styles.line} ${time ? styles.timed : ""} ${running ? styles.running : ""}`}
      data-item={id}
    >
      {tag}
      <span class={styles.text}>{children}</span>
      {time && <Time time={time} />}
    </div>
  );
}

const TIME_TITLES: Record<Timing["state"], Plain> = {
  done: "log.timeDone",
  running: "log.timeRunning",
  unfinished: "log.timeUnfinished",
};

// "12s", "⏱ 0:42" while it runs, "4m 05s, unfinished".
function Time({ time }: { time: Timing }) {
  return (
    <span class={`${styles.time} ${styles[time.state] ?? ""}`} title={t(TIME_TITLES[time.state])}>
      {timeLabel(time)}
    </span>
  );
}

// MCP servers with an icon of their own; the others get a plug.
const SERVER_ICONS: Record<string, typeof Icon.Plug> = { playwright: Icon.Browser };

// A tool's name in the tag column: as it is (Bash, Read…), or an MCP call's server as an icon,
// named by its full name, and marked when the search finds that name.
function ToolTag({ name, field }: { name: string; field: string }) {
  const { query, starts, current } = useContext(Hits);
  const mcp = toolLabel(name);
  if (!mcp) return <span class={styles.tag}>{name}</span>;
  const Glyph = SERVER_ICONS[mcp.server] ?? Icon.Plug;
  const start = starts.get(field);
  const glyph = <Glyph size={15} />;
  const cur = start !== undefined && current >= start && current < start + count(name, query);
  return (
    <span class={`${styles.tag} ${styles.toolIcon}`} role="img" aria-label={name} title={name}>
      {query && start !== undefined ? (
        <mark class={cur ? styles.current : undefined} data-current={cur ? "" : undefined}>
          {glyph}
        </mark>
      ) : (
        glyph
      )}
    </span>
  );
}

// A tool call or a build step, folded: its name, its command and how it went.
function Sub({
  id,
  error,
  open,
  onToggle,
  tag,
  head,
  meta,
  children,
}: {
  id: string;
  error: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  tag: ComponentChildren;
  head: ComponentChildren;
  meta: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <details
      class={`${styles.sub} ${error ? styles.failed : ""}`}
      open={open}
      data-item={id}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span class={styles.chevron}>
          <Icon.ChevronRight size={12} />
        </span>
        {tag}
        <span class={styles.text}>{head}</span>
        <span class={error ? styles.failedMeta : styles.subMeta}>{meta}</span>
      </summary>
      {children}
    </details>
  );
}
