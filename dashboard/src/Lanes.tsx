// The board's Lanes view: each chain of issues linked by "/after" as a lane, its compact
// nodes in the order they run (a row on a wide screen, a vertical list on a phone), named
// after its parent, its inbox or what a maintainer typed (lanes.ts laneName()), which the
// lane's header renames. The issues no arrow touches come last, on their own.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useCan } from "./access";
import { sendLaneName } from "./api";
import { sameRepo } from "./format";
import {
  asks,
  lookClasses,
  nodeClick,
  nodeHref,
  nodeLabel,
  nodeRef,
  PlaceBadge,
  QuestionBadge,
} from "./GraphDrawing";
import { moving, TONES, type GraphNode } from "./graphModel";
import { t } from "./i18n";
import { laneName, lanesOf } from "./lanes";
import type { Edge, LaneLabel, Task } from "./types";
import { Button, IconButton } from "./ui/Button";
import { Field } from "./ui/Field";
import * as Icon from "./ui/icons";
import { StatusDot } from "./ui/Status";
import styles from "./Lanes.module.css";

interface Props {
  repo: string;
  nodes: GraphNode[];
  edges: Edge[];
  // State.lanes: the names the listener knows.
  labels?: Record<string, LaneLabel>;
  github: string;
  // A phone: each lane top to bottom, 44 px rows.
  narrow: boolean;
  // Null: the user may not answer here (runs:manage), the node opens its task.
  onAsk: ((task: Task) => void) | null;
  // Reads api/state again: a new name shows from there.
  refresh?: () => Promise<void>;
}

export function Lanes({ repo, nodes, edges, labels, github, narrow, onAsk, refresh }: Props) {
  const { lanes, alone } = lanesOf(nodes, edges);
  const waits = (n: GraphNode) => edges.filter((e) => e.to === n.key).length;
  const step = (n: GraphNode, last: boolean) => (
    <li key={n.key} class={`${styles.step} ${last ? styles.last : ""}`}>
      <a
        href={nodeHref(n, repo, github)}
        class={`${styles.node} ${lookClasses(n, styles)}`}
        data-card
        data-number={n.number ?? undefined}
        aria-label={nodeLabel(n, waits(n))}
        title={t("graph.nodeTitle", { title: n.title ?? nodeRef(n, false, 0), status: n.status })}
        aria-haspopup={asks(n) && onAsk ? "dialog" : undefined}
        onClick={nodeClick(asks(n) && onAsk ? () => onAsk(n.task!) : undefined)}
        {...(n.task ? {} : { target: "_blank", rel: "noreferrer" })}
      >
        <span class={styles.rail}>
          <StatusDot tone={TONES[n.look]} pulse={moving(n)} />
        </span>
        <span class={styles.name}>
          <span class={styles.ref}>{nodeRef(n, false, 0)}</span> {n.title ?? ""}
        </span>
        <span class={styles.state}>{n.status}</span>
        <PlaceBadge n={n} class={styles.place} />
        <QuestionBadge n={n} class={styles.badge} />
      </a>
      {!narrow && !last && <Icon.ChevronRight class={styles.arrow} size={14} />}
    </li>
  );
  if (!nodes.length) return <p class={styles.empty}>{t("lanes.empty")}</p>;
  return (
    <div class={`${styles.lanes} ${narrow ? styles.narrow : ""}`}>
      {lanes.map((lane) => (
        <Lane
          key={lane[0].key}
          repo={repo}
          lane={lane}
          labels={labels}
          narrow={narrow}
          refresh={refresh}
        >
          {lane.map((n, i) => step(n, i === lane.length - 1))}
        </Lane>
      ))}
      {alone.length > 0 && (
        <section class={styles.lane} aria-label={t("lanes.alone")}>
          <div class={styles.head}>
            <h2 class={styles.title}>{t("lanes.alone")}</h2>
          </div>
          <ol class={`${styles.steps} ${styles.loose}`}>{alone.map((n) => step(n, true))}</ol>
        </section>
      )}
    </div>
  );
}

interface LaneProps {
  repo: string;
  lane: GraphNode[];
  labels?: Record<string, LaneLabel>;
  narrow: boolean;
  refresh?: () => Promise<void>;
  children: ComponentChildren;
}

// A lane: its name, which a click on Rename makes a field, and its nodes.
function Lane({ repo, lane, labels, narrow, refresh, children }: LaneProps) {
  // Naming a lane is the repo's runs:manage (listener/work.mjs).
  const renames = useCan().repo(repo, "runs:manage");
  // Its issues of this repo, which the listener names it by.
  const keys = lane.filter((n) => sameRepo(n.repo, repo)).map((n) => n.key);
  const known = laneName(
    lane.map((n) => n.key),
    labels,
  );
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name just saved, shown until api/state has it.
  const [saved, setSaved] = useState<string | null>(null);
  const name = saved ?? known.name;
  const size = narrow ? "touch" : "small";

  const save = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const result = await sendLaneName(repo, { keys, name: text.trim() });
    setSaving(false);
    if (result.error) return setError(result.error);
    setEditing(false);
    // Taken off: back to what names it otherwise, once api/state says.
    setSaved(text.trim() || null);
    await refresh?.();
    setSaved(null);
  };

  return (
    <section
      class={styles.lane}
      aria-label={t("lanes.lane", { name })}
      data-lane={lane.map((n) => n.key).join(" ")}
    >
      {editing ? (
        <form class={styles.rename} onSubmit={save}>
          <Field
            label={t("lanes.name")}
            hideLabel
            size={size}
            value={text}
            maxLength={60}
            placeholder={known.source === "fallback" ? known.name : t("lanes.namePlaceholder")}
            error={error ?? undefined}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            // A new field, opened by the button: the keyboard goes on into it.
            autoFocus
          />
          <Button
            type="submit"
            size={size}
            variant="primary"
            pending={saving}
            pendingLabel={t("lanes.saving")}
          >
            {t("lanes.save")}
          </Button>
          <Button size={size} variant="ghost" onClick={() => setEditing(false)}>
            {t("lanes.cancel")}
          </Button>
        </form>
      ) : (
        <div class={styles.head}>
          <h2 class={styles.title}>{name}</h2>
          {renames && (
            <IconButton
              variant="ghost"
              size={narrow ? "touch" : "small"}
              label={t("lanes.rename", { name })}
              icon={<Icon.Pencil size={14} />}
              disabled={!keys.length}
              onClick={() => {
                setText(known.source === "fallback" ? "" : name);
                setError(null);
                setEditing(true);
              }}
            />
          )}
        </div>
      )}
      <ol class={styles.steps}>{children}</ol>
    </section>
  );
}
