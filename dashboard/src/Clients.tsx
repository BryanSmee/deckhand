// Settings › MCP clients (#481): the MCP clients signed in as you (Claude Code, Codex, an
// editor…), from GET api/mcp/clients, which edge answers itself (edge/oauth.mjs), with Revoke.
// A client connects by itself, at this Deckhand's /mcp: it signs you in with GitHub and asks
// you to allow it. Signing out everywhere (Preferences) ends them all too. Below them, your
// machines (Machines.tsx), which a client with the deckhand:machine scope registers.
import { useState } from "preact/hooks";
import { postJson, usePolled } from "./api";
import { ago } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { McpClients } from "./types";
import { Machines } from "./Machines";
import { Button } from "./ui/Button";
import styles from "./Clients.module.css";

// Keys, written when shown: in the language chosen now.
const SCOPE_NAMES: Record<string, Plain> = {
  "deckhand:read": "config.scopeRead",
  "deckhand:work": "config.scopeWork",
  "deckhand:machine": "config.scopeMachine",
};
const scopeName = (s: string) => (SCOPE_NAMES[s] ? t(SCOPE_NAMES[s]) : s);

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
        {tx("config.clientsNote", {
          url: url ? <code class={styles.url}>{url}</code> : t("config.clientsThisMcp"),
        })}
      </p>
      <section class={styles.group} aria-labelledby="mcp-clients">
        <h2 id="mcp-clients">{t("config.clientsTitle")}</h2>
        {(error || (list.error && !clients)) && (
          <p class={styles.error} role="alert">
            {error ?? t("config.clientsUnreadable", { error: list.error ?? "" })}
          </p>
        )}
        {clients?.length === 0 && <p class={styles.empty}>{t("config.clientsNone")}</p>}
        {!clients && !list.error && <p class={styles.empty}>{t("config.clientsReading")}</p>}
        {clients?.map((c) => (
          <div key={c.id} class={styles.client}>
            <span class={styles.text}>
              <b>{c.name}</b>
              <span>
                {c.used !== null
                  ? t("config.clientUsed", {
                      connected: ago(c.created, now()),
                      used: ago(c.used, now()),
                      scopes: c.scopes.map(scopeName).join(t("list.comma")),
                    })
                  : t("config.clientConnected", {
                      connected: ago(c.created, now()),
                      scopes: c.scopes.map(scopeName).join(t("list.comma")),
                    })}
              </span>
              <span class={styles.redirect} title={t("config.clientRedirect")}>
                {c.redirect}
              </span>
            </span>
            <Button
              variant="danger"
              pending={revoking === c.id}
              disabled={revoking !== null}
              onClick={() => void revoke(c.id)}
              aria-label={t("config.revokeClient", { name: c.name })}
            >
              {t("config.revoke")}
            </Button>
          </div>
        ))}
      </section>
      <Machines now={now} />
    </div>
  );
}
