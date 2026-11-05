// Ctrl K, "Jump to": a combobox over every repo's tasks (by number or title words), the
// repositories, the boards' lanes, and actions (New request's kinds, Sync, the theme). The
// arrows move, Enter opens, Ctrl (⌘) Enter opens on GitHub. Searching run logs isn't here.
import type { ComponentChildren } from "preact";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  githubUrl,
  matchesSearch,
  repoTabs,
  sameRepo,
  taskStatus,
  type Tone,
  titleOf,
  uniqueRepos,
} from "./format";
import { useCan } from "./access";
import { graphOf } from "./graphModel";
import { t, tx } from "./i18n";
import { isMac, keyHint, type ShortcutId } from "./keys";
import { laneName, lanesOf } from "./lanes";
import type { Plain } from "./locales";
import { requestKinds } from "./NewRequest";
import type { Request } from "./Shell";
import type { State, Task } from "./types";
import * as Icon from "./ui/icons";
import { Kbd } from "./ui/Kbd";
import { useFocusTrap } from "./ui/modal";
import { StatusDot, toneClass } from "./ui/Status";
import { THEMES, type Theme } from "./prefs";
import styles from "./Palette.module.css";

// Ids, named at render (GROUP_NAMES).
export type Group = "Tasks" | "Repositories" | "Board" | "Actions";
const GROUPS: Group[] = ["Tasks", "Repositories", "Board", "Actions"];
const GROUP_NAMES: Record<Group, Plain> = {
  Tasks: "app.paletteTasks",
  Repositories: "app.paletteRepositories",
  Board: "app.paletteBoard",
  Actions: "app.paletteActions",
};

// What a pick does: the dashboard's (App.tsx).
export interface Jumps {
  task: (t: Task) => void;
  repo: (repo: string) => void;
  // The board's lanes view, the lane of issues `keys` in sight.
  lane: (repo: string, keys: string[]) => void;
  // New request on that kind, its title already typed.
  request: (kind: Request, title?: string) => void;
  sync: () => void;
  theme: (theme: Theme) => void;
}

interface Item {
  id: string;
  group: Group;
  // What the query is looked for in, and what shows (marked) unless `view` does.
  text: string;
  view?: ComponentChildren;
  icon: ComponentChildren;
  // On the right: a task's state, an action's key.
  aside?: ComponentChildren;
  tone?: Tone;
  open: () => void;
  // Its page on GitHub, for Ctrl Enter.
  url?: string | null;
}

interface Props {
  state: State;
  // The repositories the App is on, besides those with tasks.
  repos?: string[];
  // The board's "Show closed": its lanes are the board's.
  showClosed?: boolean;
  jumps: Jumps;
  onClose: () => void;
}

// How many of each group show.
const LIMITS: Record<Group, number> = { Tasks: 8, Repositories: 5, Board: 5, Actions: 8 };

const wordsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const has = (text: string, words: string[]) => words.every((w) => text.toLowerCase().includes(w));

// The query's words in `text`, marked.
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

const THEME_NAMES: Record<Theme, Plain> = {
  system: "app.paletteThemeSystem",
  light: "app.paletteThemeLight",
  dark: "app.paletteThemeDark",
};

export function Palette({ state, repos = [], showClosed = false, jumps, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useFocusTrap(box, { onClose });
  // Before the paint: what is typed right after Ctrl K lands in the box.
  useLayoutEffect(() => input.current?.focus(), []);
  const github = state.githubUrl ?? "https://github.com";
  // The actions the user may take (access.ts): New request's kinds they may send, and Sync.
  const can = useCan();
  const kinds = requestKinds(can);

  // The boards' lanes, named as the Lanes view names them.
  const lanes = useMemo(
    () =>
      repoTabs(state.tasks).flatMap(({ repo }) => {
        const tasks = state.tasks.filter((t) => sameRepo(t.repo, repo));
        // As the board draws them: closed issues too when it shows them.
        const { nodes, edges } = graphOf(tasks, state.edges ?? [], state.blockers ?? [], {
          showClosed,
        });
        return lanesOf(nodes, edges).lanes.map((lane) => ({
          repo,
          keys: lane.map((n) => n.key),
          name: laneName(
            lane.map((n) => n.key),
            state.lanes,
          ).name,
        }));
      }),
    [state.tasks, state.edges, state.blockers, state.lanes, showClosed],
  );

  const words = wordsOf(query);
  const number = /^#?(\d+)$/.exec(query.trim())?.[1];
  const shortcut = (id: ShortcutId) => <Kbd>{keyHint(id)}</Kbd>;

  const items: Item[] = [];
  // A number first finds its task, then the others it is part of ("#22": #220 too).
  const tasks = state.tasks
    .filter((t) => matchesSearch(t, query))
    .sort((a, b) => Number(b.number === Number(number)) - Number(a.number === Number(number)));
  for (const t of tasks) {
    const { tone, label } = taskStatus(t);
    items.push({
      id: `task:${t.key}`,
      group: "Tasks",
      text: titleOf(t),
      view: (
        <>
          {t.number !== null && <span class={styles.ref}>#{t.number}</span>}{" "}
          <Marked text={titleOf(t)} words={words} /> <span class={styles.repo}>· {t.repo}</span>
        </>
      ),
      icon: <StatusDot tone={tone} />,
      tone,
      aside: <span class={styles.state}>{label}</span>,
      open: () => jumps.task(t),
      url: githubUrl(t, github),
    });
  }
  const repoNames = uniqueRepos([...repoTabs(state.tasks).map((r) => r.repo), ...repos]);
  for (const repo of repoNames.filter((r) => has(r, words))) {
    items.push({
      id: `repo:${repo}`,
      group: "Repositories",
      text: repo,
      icon: <Icon.Tasks size={16} />,
      open: () => jumps.repo(repo),
      url: `${github}/${repo}`,
    });
  }
  // Only once asked for: every lane of every board is too many to list unasked.
  if (words.length) {
    for (const lane of lanes.filter((l) => has(`${l.name} ${l.repo}`, words))) {
      items.push({
        id: `lane:${lane.keys[0]}`,
        group: "Board",
        text: lane.name,
        view: tx("app.paletteLane", {
          lane: <Marked text={lane.name} words={words} />,
          repo: lane.repo,
        }),
        icon: <Icon.Board size={16} />,
        open: () => jumps.lane(lane.repo, lane.keys),
      });
    }
  }
  const typed = query.trim();
  const offered: Omit<Item, "group">[] = [
    {
      id: "idea",
      text: typed ? t("app.paletteIdeaTitled", { title: typed }) : t("app.paletteIdea"),
      icon: <Icon.Idea size={16} />,
      aside: shortcut("request"),
      open: () => jumps.request("idea", typed || undefined),
    },
    {
      id: "bug",
      text: typed ? t("app.paletteBugTitled", { title: typed }) : t("app.paletteBug"),
      icon: <Icon.Bug size={16} />,
      open: () => jumps.request("bug", typed || undefined),
    },
    {
      id: "analyze",
      text: t("app.paletteAnalyze"),
      icon: <Icon.Chart size={16} />,
      open: () => jumps.request("analyze"),
    },
    {
      id: "sync",
      text: t("app.paletteSync"),
      icon: <Icon.Sync size={16} />,
      open: jumps.sync,
    },
    ...THEMES.map((theme) => ({
      id: `theme:${theme}`,
      text: t(THEME_NAMES[theme]),
      icon:
        theme === "dark" ? (
          <Icon.Moon size={16} />
        ) : theme === "light" ? (
          <Icon.Sun size={16} />
        ) : (
          <Icon.System size={16} />
        ),
      aside: shortcut("theme"),
      open: () => jumps.theme(theme),
    })),
  ];
  const actions = offered.filter((a) =>
    a.id === "sync"
      ? can.server("server:sync")
      : ["idea", "bug", "analyze"].includes(a.id)
        ? kinds.includes(a.id as Request)
        : true,
  );
  // New idea and New bug report take any text, as their title: after what the text matches.
  const titled = (a: Omit<Item, "group">) => !!typed && (a.id === "idea" || a.id === "bug");
  for (const a of actions.filter((a) => !titled(a) && has(a.text, words)))
    items.push({ ...a, group: "Actions" });
  for (const a of actions.filter(titled)) items.push({ ...a, group: "Actions" });

  const shown = GROUPS.flatMap((g) => items.filter((i) => i.group === g).slice(0, LIMITS[g]));
  const current = shown.length ? Math.min(at, shown.length - 1) : -1;
  const optionId = (i: number) => `${listId}-${i}`;

  const pick = (item: Item | undefined, onGithub: boolean) => {
    if (!item) return;
    onClose();
    if (onGithub && item.url) window.open(item.url, "_blank", "noreferrer");
    else item.open();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setAt((current + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[current], e.ctrlKey || e.metaKey);
    }
  };

  return (
    <div
      class={styles.scrim}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        class={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label={t("app.paletteLabel")}
      >
        <label class={styles.search}>
          <Icon.Search size={18} class={styles.lead} />
          <input
            ref={input}
            class={styles.input}
            value={query}
            placeholder={t("app.palettePlaceholder")}
            aria-label={t("app.paletteInput")}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setAt(0);
            }}
            onKeyDown={onKeyDown}
          />
          <Kbd>Esc</Kbd>
        </label>
        <div id={listId} class={styles.list} role="listbox" aria-label={t("app.paletteResults")}>
          {!shown.length && <p class={styles.empty}>{t("app.paletteNothing", { query: typed })}</p>}
          {GROUPS.map((g) => {
            const inGroup = shown.filter((i) => i.group === g);
            if (!inGroup.length) return null;
            return (
              <div key={g} role="group" aria-labelledby={`${listId}-${g}`}>
                <h3 id={`${listId}-${g}`} class={styles.group}>
                  {t(GROUP_NAMES[g])}
                </h3>
                {inGroup.map((item) => {
                  const i = shown.indexOf(item);
                  return (
                    <div
                      key={item.id}
                      id={optionId(i)}
                      class={`${styles.option} ${item.tone ? toneClass(item.tone) : ""}`}
                      role="option"
                      aria-selected={i === current}
                      onMouseMove={() => i !== current && setAt(i)}
                      onClick={(e) => pick(item, e.ctrlKey || e.metaKey)}
                    >
                      <span class={styles.icon}>{item.icon}</span>
                      <span class={styles.text}>
                        {item.view ??
                          (titled(item) ? item.text : <Marked text={item.text} words={words} />)}
                      </span>
                      {item.aside ?? <span />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div class={styles.foot}>
          <span>
            {tx("app.paletteMove", {
              keys: (
                <>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </>
              ),
            })}
          </span>
          <span>{tx("app.paletteOpen", { keys: <Kbd>↵</Kbd> })}</span>
          <span>
            {tx("app.paletteOpenGithub", {
              keys: (
                <>
                  <Kbd>{isMac() ? "⌘" : "Ctrl"}</Kbd>
                  <Kbd>↵</Kbd>
                </>
              ),
            })}
          </span>
          <span class={styles.tip}>{t("app.paletteTip")}</span>
        </div>
      </div>
    </div>
  );
}
