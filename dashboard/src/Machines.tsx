// Settings › MCP clients' machines (#595): your own computers that take Deckhand's tasks, each
// registered by its driver, an MCP client with the deckhand:machine scope (listener/machines.mjs),
// from GET api/machines, with Remove. Nobody else sees them. Removing one deletes its entry: its
// claims end with it, their tasks waiting again (listener/claims.mjs, #596).
import { useState } from "preact/hooks";
import { postJson, usePolled } from "./api";
import { ago } from "./format";
import { t } from "./i18n";
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
      <h2 id="machines">{t("machines.title")}</h2>
      <p class={styles.warning}>{t("machines.warning")}</p>
      {error && (
        <p class={styles.error} role="alert">
          {error}
        </p>
      )}
      {list.error && !machines && (
        <p class={styles.error}>{t("machines.unreadable", { error: list.error })}</p>
      )}
      {machines?.length === 0 && <p class={styles.empty}>{t("machines.none")}</p>}
      {!machines && !list.error && <p class={styles.empty}>{t("machines.reading")}</p>}
      {machines?.map((m) => (
        <div key={m.id} class={styles.client}>
          <span class={styles.text}>
            <span class={styles.title}>
              <b>{m.name}</b>
              <StatusBadge
                tone={m.online ? "done" : "idle"}
                label={t(m.online ? "machines.online" : "machines.offline")}
              />
            </span>
            <span>
              {[
                m.labels.length ? m.labels.join(t("list.comma")) : t("machines.noLabels"),
                t("machines.capacity", { count: m.capacity }),
                t("machines.seen", { ago: ago(m.seenAt, now()) }),
                m.version && t("machines.driver", { version: m.version }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span class={styles.redirect} title={t("machines.repos")}>
              {m.repos.join(t("list.comma"))}
            </span>
          </span>
          <Button
            variant="danger"
            pending={removing === m.id}
            disabled={removing !== null}
            onClick={() => void remove(m.id)}
            aria-label={t("machines.removeOne", { name: m.name })}
          >
            {t("machines.remove")}
          </Button>
        </div>
      ))}
    </section>
  );
}
