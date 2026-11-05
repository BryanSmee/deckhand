// A machine task on its page (listener/claims.mjs, #596): whose machines take it and whether one
// does now (MachineFact, among the task's facts), and the comments other people left on it, held
// until its owner delivers or drops them (HeldComments): only the owner gets the buttons, and the
// orchestrator refuses anyone else.
import { useState } from "preact/hooks";
import { postJson } from "./api";
import { ago, machineName } from "./format";
import type { Task } from "./types";
import { Button } from "./ui/Button";
import styles from "./MachineTask.module.css";

// "Runs on @alice's machines labelled unreal: waiting for one to claim it", "Claimed by
// @alice's Desk".
export function MachineFact({ task: t }: { task: Task }) {
  const m = t.machine;
  if (!m) return null;
  const title = m.via === "label" ? `Its runs-on:${m.want} label` : "A /machine comment";
  if (m.claimed)
    return (
      <span title={title}>
        Claimed by @{m.owner}'s {machineName(m)}
      </span>
    );
  const asked = m.machine
    ? `@${m.owner}'s ${m.machine}`
    : `@${m.owner}'s machines ${m.via === "label" ? `labelled ${m.want}` : `(${m.want})`}`;
  const now = m.available
    ? `waiting for ${m.machine ? "it" : "one of them"} to claim it`
    : m.machine
      ? "it is offline"
      : "none of them is online";
  return (
    <span title={title}>
      Runs on {asked}: {now}
    </span>
  );
}

interface Props {
  task: Task;
  // The signed-in login: the owner's alone deliver or drop.
  user?: string;
  now: number;
  // Reads api/state again once one went through.
  refresh?: () => Promise<void>;
}

export function HeldComments({ task: t, user, now, refresh }: Props) {
  const [acting, setActing] = useState<"deliver" | "drop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = t.held ?? [];
  if (!held.length || !t.machine || t.number === null) return null;
  const owner = t.machine.owner;
  const mine = !!user && user.toLowerCase() === owner.toLowerCase();

  async function act(action: "deliver" | "drop") {
    setActing(action);
    setError(null);
    const answer = await postJson(`api/held/${t.repo}/${t.number}/${action}`);
    if (answer.error) setError(answer.error);
    await refresh?.();
    setActing(null);
  }

  return (
    <section class={styles.held} aria-label="Held comments">
      <h3>
        {held.length === 1 ? "1 comment held" : `${held.length} comments held`} for @{owner}
      </h3>
      <p class={styles.note}>
        This task runs on @{owner}'s machines: other people's comments reach its runs once @{owner}{" "}
        delivers them.
      </p>
      <ul>
        {held.map((c, i) => (
          <li key={i}>
            <span class={styles.who}>
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  @{c.author ?? "someone"}
                </a>
              ) : (
                `@${c.author ?? "someone"}`
              )}
              {c.at !== null && ` · ${ago(c.at, now)}`}
            </span>
            <span class={styles.text}>{c.text}</span>
          </li>
        ))}
      </ul>
      {error && (
        <p class={styles.error} role="alert">
          {error}
        </p>
      )}
      {mine && (
        <div class={styles.actions}>
          <Button
            size="small"
            pending={acting === "deliver"}
            pendingLabel="Delivering…"
            disabled={acting !== null}
            onClick={() => void act("deliver")}
          >
            Deliver
          </Button>
          <Button
            variant="ghost"
            size="small"
            pending={acting === "drop"}
            pendingLabel="Dropping…"
            disabled={acting !== null}
            onClick={() => void act("drop")}
          >
            Drop
          </Button>
        </div>
      )}
    </section>
  );
}
