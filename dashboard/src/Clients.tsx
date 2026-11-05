// Settings › MCP clients (#481): the MCP clients signed in as you (Claude Code, Codex, an
// editor…), from GET api/mcp/clients, which edge answers itself (edge/oauth.mjs), with Revoke.
// A client connects by itself, at this Deckhand's /mcp: it signs you in with GitHub and asks
// you to allow it. Signing out everywhere (Preferences) ends them all too. Below them, your
// machines (Machines.tsx), which a client with the deckhand:machine scope registers.
import { useState } from "preact/hooks";
import { postJson, usePolled } from "./api";
import { ago } from "./format";
import type { McpClients } from "./types";
import { Machines } from "./Machines";
import { Button } from "./ui/Button";
import styles from "./Clients.module.css";

const SCOPE_NAMES: Record<string, string> = {
  "deckhand:read": "Read",
  "deckhand:work": "Work",
  "deckhand:machine": "Machine",
};

export function Clients({ now = Date.now }: { now?: () => number }) {
  const list = usePolled<McpClients>("api/mcp/clients", null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clients = list.data?.clients ?? null;
  // The public URL's /mcp, which edge says: the page's own origin may be another (a LAN port).
  const url = list.data?.resource ?? null;

  async function revoke(id: string) {
    setRevoking(id);
    setError(null);
    const answer = await postJson<{ revoked?: boolean }>(`api/mcp/clients/${id}/revoke`);
    if (answer.error) setError(answer.error);
    else list.show((last) => last && { ...last, clients: last.clients.filter((c) => c.id !== id) });
    setRevoking(null);
    await list.reload();
  }

  return (
    <div class={styles.page}>
      <p class={styles.note}>
        An MCP client connects to{" "}
        {url ? <code class={styles.url}>{url}</code> : "this Deckhand's /mcp"}, signs you in with
        GitHub and asks you to allow it. It acts as you, with your rights on this dashboard. Signing
        out ends every one of them too.
      </p>
      <section class={styles.group} aria-labelledby="mcp-clients">
        <h2 id="mcp-clients">Signed in as you</h2>
        {(error || (list.error && !clients)) && (
          <p class={styles.error} role="alert">
            {error ?? `Can't read the clients: ${list.error}`}
          </p>
        )}
        {clients?.length === 0 && <p class={styles.empty}>No MCP client is signed in as you.</p>}
        {!clients && !list.error && <p class={styles.empty}>Reading…</p>}
        {clients?.map((c) => (
          <div key={c.id} class={styles.client}>
            <span class={styles.text}>
              <b>{c.name}</b>
              <span>
                Connected {ago(c.created, now())}
                {c.used !== null && ` · last used ${ago(c.used, now())}`}
                {" · "}
                {c.scopes.map((s) => SCOPE_NAMES[s] ?? s).join(", ")}
              </span>
              <span class={styles.redirect} title="Where it was sent back after you allowed it">
                {c.redirect}
              </span>
            </span>
            <Button
              variant="danger"
              pending={revoking === c.id}
              disabled={revoking !== null}
              onClick={() => void revoke(c.id)}
              aria-label={`Revoke ${c.name}`}
            >
              Revoke
            </Button>
          </div>
        ))}
      </section>
      <Machines now={now} />
    </div>
  );
}
