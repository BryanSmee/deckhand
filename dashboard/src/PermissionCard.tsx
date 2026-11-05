// A chat's agent's request for more permissions (listener/requests.mjs, #479), in the
// conversation while it waits for the chat's owner: what it asks for, its reason (the agent's
// words, one line, redacted, always text), when an approval applies, and how long until no
// answer denies it. Approve once (the sandbox going, or its next start alone), Approve for this
// chat (its permissions profile keeps it), Deny.
import { useState } from "preact/hooks";
import { answerRequest } from "./api";
import { plural } from "./format";
import type { Chat, PermissionAnswer, PermissionKind, PermissionRequest } from "./types";
import { Button } from "./ui/Button";
import * as Icon from "./ui/icons";
import styles from "./PermissionCard.module.css";

const KINDS: Record<PermissionKind, string> = {
  host: "a host",
  github: "GitHub access",
  engine: "a container engine",
  mount: "a host mount",
};

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

  return (
    <section class={styles.card} aria-label={`The agent asks for ${KINDS[request.kind]}`}>
      <p class={styles.title}>
        <Icon.Alert size={16} />
        <span>
          The agent asks for {KINDS[request.kind]}
          {/* The engine's name says no more than its kind. */}
          {request.what !== KINDS[request.kind] && (
            <>
              : <span class={styles.what}>{request.what}</span>
            </>
          )}
        </span>
      </p>
      {request.reason && <p class={styles.reason}>{request.reason}</p>}
      <p class={styles.meta}>
        {request.live
          ? "Applies to its sandbox at once."
          : "Applies when its sandbox starts again: Restart now, in the chat's permissions, once the agent has answered."}{" "}
        Denied in {plural(minutes, "minute")} without an answer.
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
          Approve once
        </Button>
        <Button
          size="small"
          pending={busy === "chat"}
          disabled={!!busy && busy !== "chat"}
          onClick={() => void answer("chat")}
        >
          Approve for this chat
        </Button>
        <Button
          size="small"
          variant="danger"
          pending={busy === "deny"}
          disabled={!!busy && busy !== "deny"}
          onClick={() => void answer("deny")}
        >
          Deny
        </Button>
      </div>
    </section>
  );
}
