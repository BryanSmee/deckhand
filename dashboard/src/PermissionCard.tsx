// A chat's agent's request for more permissions (listener/requests.mjs, #479), in the
// conversation while it waits for the chat's owner: what it asks for, its reason (the agent's
// words, one line, redacted, always text), when an approval applies, and how long until no
// answer denies it. Approve once (the sandbox going, or its next start alone), Approve for this
// chat (its permissions profile keeps it), Deny.
import { useState } from "preact/hooks";
import { answerRequest } from "./api";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { Chat, PermissionAnswer, PermissionKind, PermissionRequest } from "./types";
import { Button } from "./ui/Button";
import * as Icon from "./ui/icons";
import styles from "./PermissionCard.module.css";

// What the agent asks for, by kind. Keys: written when shown.
const ASKS: Record<PermissionKind, Plain> = {
  host: "chats.asksHost",
  github: "chats.asksGithub",
  engine: "chats.asksEngine",
  mount: "chats.asksMount",
};

// The engine's name as the listener writes it (in English): it says no more than its kind.
const ENGINE = "a container engine";

interface Props {
  chatId: string;
  request: PermissionRequest;
  now: number;
  // The chat as the listener answered.
  onChat: (chat: Chat) => void;
}

export function PermissionCard({ chatId, request, now, onChat }: Props) {
  const [busy, setBusy] = useState<PermissionAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const minutes = Math.max(1, Math.ceil((request.expiresAt - now) / 60_000));

  const answer = async (choice: PermissionAnswer) => {
    setBusy(choice);
    setError(null);
    const said = await answerRequest(chatId, request.id, choice);
    setBusy(null);
    if (said.error) return setError(said.error);
    onChat(said.chat);
  };

  const asks = t(ASKS[request.kind]);
  return (
    <section class={styles.card} aria-label={asks}>
      <p class={styles.title}>
        <Icon.Alert size={16} />
        <span>
          {request.kind === "engine" && request.what === ENGINE
            ? asks
            : tx("chats.asksWhat", {
                asks,
                what: <span class={styles.what}>{request.what}</span>,
              })}
        </span>
      </p>
      {request.reason && <p class={styles.reason}>{request.reason}</p>}
      <p class={styles.meta}>
        {t(request.live ? "chats.appliesNow" : "chats.appliesLater")}{" "}
        {t("chats.deniedIn", { count: minutes })}
      </p>
      {error && (
        <p class={styles.failed} role="alert">
          {error}
        </p>
      )}
      <div class={styles.actions}>
        <Button
          size="small"
          variant="primary"
          pending={busy === "once"}
          disabled={!!busy && busy !== "once"}
          onClick={() => void answer("once")}
        >
          {t("chats.approveOnce")}
        </Button>
        <Button
          size="small"
          pending={busy === "chat"}
          disabled={!!busy && busy !== "chat"}
          onClick={() => void answer("chat")}
        >
          {t("chats.approveChat")}
        </Button>
        <Button
          size="small"
          variant="danger"
          pending={busy === "deny"}
          disabled={!!busy && busy !== "deny"}
          onClick={() => void answer("deny")}
        >
          {t("chats.deny")}
        </Button>
      </div>
    </section>
  );
}
