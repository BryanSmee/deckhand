// A run's log, folded into its sections (logModel.ts): setup, the image's build (its steps,
// cached ones together, a failed one open), the work (messages as text, tool calls folded,
// a failed one open) and the pushes. A section with an error opens by itself; the others
// start folded, except the work. A toolbar searches it (the folds holding the matches open),
// filters it, folds it all and copies or downloads it; a phone has an action bar instead,
// and its search replaces the page's header. A live run's log follows its end until the
// reader scrolls up; Latest brings it back.
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useRunLog } from "./api";
import { plural } from "./format";
import {
  cachedLine,
  type Filter,
  isError,
  type Item,
  type LogSection,
  logSections,
  PHASE_TITLES,
  plainText,
  resultTitle,
  search,
  shortDuration,
  shown,
  type Step,
  stepName,
  stepStatus,
} from "./logModel";
import type { Run } from "./types";
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
  now: number;
  // A phone's: the action bar, and a search that takes the page's header.
  touch?: boolean;
  searching?: boolean;
  onSearching?: (on: boolean) => void;
}

const FILTERS: { value: Filter; label: string; phone: string }[] = [
  { value: "all", label: "All", phone: "Everything" },
  { value: "messages", label: "Messages", phone: "Messages" },
  { value: "tools", label: "Tools", phone: "Tool output" },
  { value: "errors", label: "Errors", phone: "Errors" },
];

// What the highlighting reads: the query, where each field's matches start, the current one.
const Hits = createContext<{ query: string; starts: Map<string, number>; current: number }>({
  query: "",
  starts: new Map(),
  current: -1,
});

// Near enough to the end to keep following it.
const NEAR_END = 40;

export function Log({ run, now, touch, searching, onSearching }: Props) {
  const { entries } = useRunLog(run.id);
  const live = run.status === "running";
  const list = useMemo(
    () => logSections(entries, run.finishedAt ?? now, live),
    [entries, run.finishedAt, now, live],
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [current, setCurrent] = useState(0);
  // Folds the reader opened or closed, then Expand all or Collapse all (null: neither).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<boolean | null>(null);
  // The error Next error went to: held open.
  const [focus, setFocus] = useState<string | null>(null);
  const [following, setFollowing] = useState(live);
  const [copied, setCopied] = useState(false);
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
  const isOpen = (id: string, fallback: boolean) =>
    held.has(id) || (overrides[id] ?? (query && found.hits.get(id) ? true : (all ?? fallback)));
  // Only what the reader did: the echo of an `open` set from here changes nothing.
  const toggle = (id: string, fallback: boolean) => (open: boolean) => {
    if (open !== isOpen(id, fallback)) setOverrides((o) => ({ ...o, [id]: open }));
  };

  const find = (q: string) => {
    setQuery(q);
    setCurrent(0);
    setOverrides({});
  };
  const step = (by: number) => total && setCurrent((at + by + total) % total);
  const foldAll = (open: boolean) => {
    setOverrides({});
    setFocus(null);
    setAll(open);
  };
  const nextError = () => {
    if (!errors.length) return;
    const i = errors.findIndex((e) => e.item === focus);
    setFocus(errors[(i + 1) % errors.length].item);
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
    await navigator.clipboard?.writeText(text());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const visible = list.filter((s) => filter === "all" || s.items.some((i) => shown(i, filter)));
  const counter = query ? (total ? `${at + 1} / ${total}` : "0 / 0") : "";
  const searchBox = (
    <div class={styles.searchBox}>
      <Field
        label="Search this log"
        hideLabel
        type="search"
        size={touch ? "touch" : "small"}
        lead={<Icon.Search size={touch ? 18 : 14} />}
        value={query}
        autoFocus={touch}
        onInput={(e) => find((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          if (e.key === "Escape" && touch) onSearching?.(false);
        }}
        class={styles.searchField}
      />
      <span class={styles.trail}>
        {touch ? (
          query && (
            <IconButton
              variant="ghost"
              size="small"
              label="Clear the search"
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
              label="Previous match"
              icon={<Icon.ChevronUp size={14} />}
              disabled={!total}
              onClick={() => step(-1)}
            />
            <IconButton
              variant="ghost"
              size="small"
              class={styles.tiny}
              label="Next match"
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
    <div class={styles.wrap} ref={root}>
      {touch && searching ? (
        <div class={styles.phoneSearch}>
          <div class={styles.phoneSearchRow}>
            {searchBox}
            <Button
              variant="ghost"
              size="touch"
              onClick={() => {
                find("");
                setFilter("all");
                onSearching?.(false);
              }}
            >
              Done
            </Button>
          </div>
          <div class={styles.chips} role="group" aria-label="Search in">
            {FILTERS.map((f) => (
              <FilterChip
                key={f.value}
                pressed={filter === f.value}
                count={f.value === "errors" ? errors.length : undefined}
                onClick={() => setFilter(f.value)}
              >
                {f.phone}
              </FilterChip>
            ))}
          </div>
        </div>
      ) : (
        !touch && (
          <div class={styles.toolbar}>
            {searchBox}
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({
                value: f.value,
                label: f.label,
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
              <Button variant="ghost" size="small" onClick={() => foldAll(true)}>
                Expand all
              </Button>
              <Button variant="ghost" size="small" onClick={() => foldAll(false)}>
                Collapse all
              </Button>
              <IconButton
                variant="ghost"
                size="small"
                label={copied ? "Copied" : "Copy the log"}
                icon={copied ? <Icon.Check size={15} /> : <Icon.Copy size={15} />}
                onClick={copy}
              />
              <IconButton
                variant="ghost"
                size="small"
                label="Download the log as text"
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
          aria-label={query ? `Run log, searched for “${query}”` : "Run log"}
          data-testid="log"
        >
          {visible.map((s) => (
            <SectionView
              key={s.phase}
              section={s}
              filter={filter}
              open={isOpen(s.phase, s.failures > 0 || s.phase === "work")}
              onToggle={toggle(s.phase, s.failures > 0 || s.phase === "work")}
              hits={query ? (found.hits.get(s.phase) ?? 0) : null}
              isOpen={isOpen}
              toggle={toggle}
            />
          ))}
          {!list.length && (
            <p class={styles.empty}>{live ? "Starting…" : "Nothing in this log."}</p>
          )}
          {live && (
            <p class={styles.live}>
              <StatusDot state="running" />
              {following ? "Working… following the log live" : "Working…"}
            </p>
          )}
        </div>
      </Hits.Provider>

      {!touch && live && !following && (
        <Button
          class={styles.follow}
          size="small"
          icon={<Icon.ArrowDown size={14} />}
          onClick={latest}
        >
          Latest
        </Button>
      )}

      {touch &&
        (searching ? (
          <nav class={styles.bar} aria-label="Matches">
            <IconButton
              size="touch"
              label="Previous match"
              icon={<Icon.ChevronUp size={20} />}
              disabled={!total}
              onClick={() => step(-1)}
            />
            <span class={styles.where} role="status">
              {query ? (
                total ? (
                  <>
                    <b>{at + 1}</b> of {total} · in {PHASE_TITLES[match.section]}
                  </>
                ) : (
                  "No match"
                )
              ) : (
                "Search this log"
              )}
            </span>
            <IconButton
              size="touch"
              label="Next match"
              icon={<Icon.ChevronDown size={20} />}
              disabled={!total}
              onClick={() => step(1)}
            />
          </nav>
        ) : (
          <nav class={`${styles.bar} ${styles.actions}`} aria-label="Log">
            <button type="button" onClick={() => onSearching?.(true)}>
              <Icon.Search size={20} />
              Search
            </button>
            <button
              type="button"
              class={errors.length ? styles.hasErrors : ""}
              disabled={!errors.length}
              onClick={nextError}
            >
              <Icon.Alert size={20} />
              Next error
            </button>
            <button type="button" onClick={() => foldAll(false)}>
              <Icon.Expand size={20} />
              Fold all
            </button>
            <button type="button" onClick={latest}>
              <Icon.ArrowDown size={20} />
              Latest
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
  const tone = s.failures ? "err" : s.current ? "run" : "done";
  return (
    <Fold
      title={PHASE_TITLES[s.phase]}
      tone={tone}
      pulse={s.current}
      open={open}
      onToggle={onToggle}
      class={hits === 0 ? styles.missed : undefined}
      meta={
        <>
          {hits !== null ? (
            <span class={hits ? styles.hits : undefined}>
              {hits ? plural(hits, "match", "matches") : "no match"}
            </span>
          ) : (
            <span class={styles.counts}>{counts(s)}</span>
          )}
          {s.failures > 0 && <StatusBadge tone="err" label={failed(s)} class={styles.badge} />}
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
    return [plural(steps.length, "step"), cached ? `${cached} cached` : ""]
      .filter(Boolean)
      .join(" · ");
  }
  const said = s.items.filter((i) => i.kind === "say").length;
  const tools = s.items.filter((i) => i.kind === "tool").length;
  const parts = [said ? plural(said, "message") : "", tools ? plural(tools, "tool call") : ""];
  if (!said && !tools) parts.push(plural(s.items.length, "line"));
  return parts.filter(Boolean).join(" · ");
}

function failed(s: LogSection): string {
  if (s.phase === "image") return plural(s.failures, "failed step");
  return plural(s.failures, "failed command");
}

// A field's text with its matches marked; the current one stands out.
function Hl({ text, field }: { text: string; field: string }) {
  const { query, starts, current } = useContext(Hits);
  const start = starts.get(field);
  if (!query || start === undefined) return <>{text}</>;
  const parts: ComponentChildren[] = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  let n = start;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, from)) {
    parts.push(text.slice(from, i));
    const cur = n === current;
    parts.push(
      <mark key={n} class={cur ? styles.current : undefined} data-current={cur ? "" : undefined}>
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    n++;
    from = i + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

interface ItemProps {
  item: Item;
  isOpen: (id: string, fallback: boolean) => boolean;
  toggle: (id: string, fallback: boolean) => (open: boolean) => void;
}

function ItemView({ item, isOpen, toggle }: ItemProps) {
  const f = (i: number) => `${item.id}:${i}`;
  switch (item.kind) {
    case "say":
      return (
        <p class={styles.say} data-item={item.id}>
          <Hl text={item.text} field={f(0)} />
        </p>
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
          <span class={styles.text}>
            <Hl text={item.text} field={f(0)} />
          </span>
        </div>
      );
    case "output":
      return (
        <pre class={`${styles.out} ${item.error ? styles.error : ""}`} data-item={item.id}>
          <Hl text={item.text || "(no output)"} field={f(0)} />
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
          <span class={styles.tag}>build</span>
          <span class={styles.text}>
            <Hl text={cachedLine(item.steps)} field={f(0)} />
          </span>
        </div>
      );
    case "tool": {
      const error = item.outputs.some((o) => o.error);
      if (!item.outputs.length)
        return (
          <div class={styles.line} data-item={item.id}>
            <span class={styles.tag}>{item.name}</span>
            <span class={styles.text}>
              <Hl text={item.text} field={f(0)} />
            </span>
          </div>
        );
      const lines = item.outputs.reduce((n, o) => n + o.text.split("\n").length, 0);
      return (
        <Sub
          id={item.id}
          error={error}
          open={isOpen(item.id, error)}
          onToggle={toggle(item.id, error)}
          tag={item.name}
          head={<Hl text={item.text || " "} field={f(0)} />}
          meta={error ? "failed" : plural(lines, "line")}
        >
          {item.outputs.map((o, i) => (
            <pre key={i} class={`${styles.out} ${o.error ? styles.error : ""}`}>
              <Hl text={o.text || "(no output)"} field={f(i + 1)} />
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
  const status = stepStatus(s);
  const error = s.status === "error";
  const meta = error
    ? "failed"
    : [
        s.output.length ? plural(s.output.length, "line") : "",
        s.seconds !== null ? `${s.seconds}s` : "",
      ]
        .filter(Boolean)
        .join(" · ") || status.toLowerCase();
  if (!s.output.length && !error)
    return (
      <div class={styles.line} data-item={id}>
        <span class={styles.tag}>build</span>
        <span class={styles.text}>
          <Hl text={stepName(s)} field={f(0)} />
          {status && (
            <span class={styles.muted}>
              {" · "}
              <Hl text={status} field={f(1)} />
            </span>
          )}
        </span>
      </div>
    );
  const fallback = error || s.status === "running";
  return (
    <Sub
      id={id}
      error={error}
      open={isOpen(id, fallback)}
      onToggle={toggle(id, fallback)}
      tag={`#${s.step}`}
      head={<Hl text={stepName(s)} field={f(0)} />}
      meta={meta}
    >
      <pre class={`${styles.out} ${error ? styles.error : ""}`}>
        {s.output.map((line, i) => (
          <span key={i}>
            <Hl text={line} field={f(i + 1)} />
            {"\n"}
          </span>
        ))}
        {status && <Hl text={status} field={f(s.output.length + 1)} />}
      </pre>
    </Sub>
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
  tag: string;
  head: ComponentChildren;
  meta: string;
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
        <span class={styles.tag}>{tag}</span>
        <span class={styles.text}>{head}</span>
        <span class={error ? styles.failedMeta : styles.subMeta}>{meta}</span>
      </summary>
      {children}
    </details>
  );
}
