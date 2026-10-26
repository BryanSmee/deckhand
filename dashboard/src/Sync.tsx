// The header's Sync: GitHub sometimes loses webhook deliveries (an outage, the listener
// restarting). The listener asks for the failed ones again every few minutes on its own; this
// asks now, and reads the open pull requests' states again, then the board.
import { useEffect, useState } from "preact/hooks";
import { postJson } from "./api";
import { plural } from "./format";
import type { SyncResult } from "./types";
import styles from "./App.module.css";

// How long what it did stays shown.
const SHOWN_MS = 8000;

export function syncMessage({
  redelivered,
  pulls,
}: Pick<SyncResult, "redelivered" | "pulls">): string {
  if (!redelivered && !pulls) return "Up to date with GitHub";
  const done = [
    redelivered && `${plural(redelivered, "missed delivery", "missed deliveries")} asked again`,
    pulls && `${plural(pulls, "pull request")} updated`,
  ].filter(Boolean);
  return `Synced: ${done.join(", ")}`;
}

export function SyncButton({ onSynced }: { onSynced?: () => Promise<void> }) {
  const [syncing, setSyncing] = useState(false);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [said]);

  const sync = async () => {
    setSyncing(true);
    setSaid(null);
    const body = await postJson<SyncResult>("api/sync");
    if (body.error) setSaid({ text: `Couldn't sync (${body.error})`, failed: true });
    else {
      setSaid({ text: syncMessage(body), failed: false });
      await onSynced?.();
    }
    setSyncing(false);
  };

  return (
    <span class={styles.sync}>
      <button
        type="button"
        class={styles.syncButton}
        disabled={syncing}
        onClick={() => void sync()}
        title="Ask GitHub again for the webhook deliveries it couldn't hand over, and for the open pull requests' states"
      >
        {syncing ? "Syncing…" : "Sync"}
      </button>
      {said && (
        <span role="status" class={said.failed ? styles.syncFailed : styles.synced}>
          {said.text}
        </span>
      )}
    </span>
  );
}
