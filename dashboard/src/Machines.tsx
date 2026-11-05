// Settings › MCP clients' machines (#595): your own computers that take Deckhand's tasks, each
// registered by its driver, an MCP client with the deckhand:machine scope (listener/machines.mjs),
// from GET api/machines, with Remove. Nobody else sees them. Removing one deletes its entry (its
// claims, once machines take tasks, #596, end with it).
import { useState } from "preact/hooks";
import { postJson, usePolled } from "./api";
import { ago } from "./format";
import type { Machines as MachineList } from "./types";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/Status";
import styles from "./Clients.module.css";

// Online needs a heartbeat every 30 s: read again about as often.
const POLL_MS = 30_000;

export function Machines({ now = Date.now }: { now?: () => number }) {
  const list = usePolled<MachineList>("api/machines", POLL_MS);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const machines = list.data?.machines ?? null;

  async function remove(id: string) {
    setRemoving(id);
    setError(null);
    const answer = await postJson<{ removed?: string }>(`api/machines/${id}/remove`);
    if (answer.error) setError(answer.error);
    else
      list.show((last) => last && { ...last, machines: last.machines.filter((m) => m.id !== id) });
    setRemoving(null);
    await list.reload();
  }

  return (
    <section class={styles.group} aria-labelledby="machines">
      <h2 id="machines">Your machines</h2>
      <p class={styles.warning}>
        An agent runs on these machines on its own, with your files, credentials and network.
        Deckhand suggests settings for it and enforces none: what it may do there is up to you.
      </p>
      {error && (
        <p class={styles.error} role="alert">
          {error}
        </p>
      )}
      {list.error && !machines && <p class={styles.error}>Can't read the machines: {list.error}</p>}
      {machines?.length === 0 && (
        <p class={styles.empty}>
          No machine is registered: a machine's driver registers it, signed in as you.
        </p>
      )}
      {!machines && !list.error && <p class={styles.empty}>Reading…</p>}
      {machines?.map((m) => (
        <div key={m.id} class={styles.client}>
          <span class={styles.text}>
            <span class={styles.title}>
              <b>{m.name}</b>
              <StatusBadge
                tone={m.online ? "done" : "idle"}
                label={m.online ? "Online" : "Offline"}
              />
            </span>
            <span>
              {m.labels.length ? m.labels.join(", ") : "No labels"}
              {" · "}
              {m.capacity === 1 ? "1 run at once" : `${m.capacity} runs at once`}
              {" · "}
              last seen {ago(m.seenAt, now())}
              {m.version && ` · driver ${m.version}`}
            </span>
            <span class={styles.redirect} title="The repositories it takes">
              {m.repos.join(", ")}
            </span>
          </span>
          <Button
            variant="danger"
            pending={removing === m.id}
            disabled={removing !== null}
            onClick={() => void remove(m.id)}
            aria-label={`Remove ${m.name}`}
          >
            Remove
          </Button>
        </div>
      ))}
    </section>
  );
}
