// A chat's permissions panel (#478): its permissions profile as toggles, within what a chat run
// of its repository may get (listener/profiles.mjs, its ceiling): the GitHub level, the
// capabilities, the granted hosts and mounts. What the ceiling doesn't allow shows greyed out,
// with the reason. Saved for the sandbox's next start; "Restart now" stops the one going once its
// agent has answered, its session kept. Enforced in the sandbox (the GitHub gateway, the egress
// proxy, the runner); the dashboard edits toggles, never policy text.
import { useEffect, useState } from "preact/hooks";
import { getChatPermissions, restartChat, saveChatPermissions } from "./api";
import { t } from "./i18n";
import type { Plain } from "./locales";
import type { ChatPermissions as Permissions, ChatProfile, GithubLevel } from "./types";
import { Button } from "./ui/Button";
import { OptionCard, Switch } from "./ui/Choice";
import { Alert } from "./ui/icons";
import styles from "./ChatPermissions.module.css";

const DOCS = "https://github.com/BryanSmee/deckhand/blob/main/docs/security.md#chats";

// What each GitHub level and capability is called here: keys, written when shown.
const LEVELS: Record<GithubLevel, Plain> = {
  read: "chats.levelRead",
  comment: "chats.levelComment",
  push: "chats.levelPush",
};
const NAMES: Record<string, Plain> = {
  pull: "chats.capPull",
  setup: "chats.capSetup",
  "image:repo": "chats.capImageRepo",
  "image:branch": "chats.capImageBranch",
  docker: "chats.capDocker",
  internet: "chats.capInternet",
  "read:issues": "chats.capReadIssues",
  "read:pulls": "chats.capReadPulls",
  "read:discussions": "chats.capReadDiscussions",
  "read:actions": "chats.capReadActions",
};

// What the panel edits: every list concrete (what is on), from what the next run gets.
interface Draft {
  github: GithubLevel;
  capabilities: string[];
  hosts: string[];
  mounts: { target: string; readOnly: boolean }[];
}

const draftOf = ({ effective }: Permissions): Draft => ({
  github: effective.github,
  capabilities: [...effective.capabilities],
  hosts: [...effective.hosts],
  mounts: effective.mounts.map((m) => ({ ...m })),
});

// The profile to save: a list holding everything the ceiling allows is null, so that what the
// operator grants later is on too.
function profileOf(draft: Draft, { ceiling }: Permissions): ChatProfile {
  const allowed = ceiling.capabilities.filter((c) => c.allowed).map((c) => c.name);
  const all = <T,>(list: T[], every: T[]) => (list.length === every.length ? null : list);
  return {
    github: draft.github,
    capabilities: all(draft.capabilities, allowed),
    hosts: all(draft.hosts, ceiling.hosts),
    mounts:
      draft.mounts.length === ceiling.mounts.length && draft.mounts.every((m) => m.readOnly)
        ? null
        : draft.mounts,
  };
}

const toggled = (list: string[], name: string, on: boolean) =>
  on ? [...list, name] : list.filter((n) => n !== name);

export function ChatPermissions({ chatId }: { chatId: string }) {
  const [view, setView] = useState<Permissions | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "restart" | null>(null);

  useEffect(() => {
    let gone = false;
    getChatPermissions(chatId).then((said) => {
      if (gone) return;
      if (said.error) return setError(said.error);
      setView(said);
      setDraft(draftOf(said));
    });
    return () => {
      gone = true;
    };
  }, [chatId]);

  if (error) {
    return (
      <section class={styles.panel} aria-label={t("chats.permissions")}>
        <p class={styles.alert} role="alert">
          <Alert size={16} />
          {error}
        </p>
      </section>
    );
  }
  if (!view || !draft) {
    return (
      <section class={styles.panel} aria-label={t("chats.permissions")} aria-busy="true">
        <p class={styles.note}>{t("chats.permissionsLoading")}</p>
      </section>
    );
  }

  const { ceiling } = view;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(view));
  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setRefused([]);
    setNote(null);
  };
  // Turning one off turns off what needs it; turning one on, what it needs.
  const toggle = (name: string, on: boolean) => {
    let caps = toggled(draft.capabilities, name, on);
    const rows = ceiling.capabilities;
    for (let again = true; again;) {
      const before = caps.length;
      caps = on
        ? [
            ...new Set([
              ...caps,
              ...rows.filter((r) => caps.includes(r.name)).flatMap((r) => r.needs),
            ]),
          ]
        : caps.filter((c) => rows.find((r) => r.name === c)?.needs.every((n) => caps.includes(n)));
      again = caps.length !== before;
    }
    set({ capabilities: rows.map((r) => r.name).filter((n) => caps.includes(n)) });
  };

  async function save() {
    setPending("save");
    const said = await saveChatPermissions(chatId, profileOf(draft!, view!));
    setPending(null);
    if (said.error) {
      // The listener's reasons quote names as Markdown: plain text here.
      setRefused(
        (said.errors?.length ? said.errors : [said.error]).map((e) => e.replaceAll("`", "")),
      );
      return;
    }
    setView(said);
    setDraft(draftOf(said));
    setNote(said.running ? t("chats.savedRunning") : t("chats.savedNext"));
  }

  async function restart() {
    setPending("restart");
    const said = await restartChat(chatId);
    setPending(null);
    setNote(said.error ?? said.message);
    if (!said.error) setView({ ...view!, running: false });
  }

  // `push` is the GitHub level's: its own toggle would say the same.
  const capabilities = ceiling.capabilities.filter((c) => c.name !== "push");
  const internet = draft.capabilities.includes("internet");
  return (
    <section class={styles.panel} aria-labelledby="chat-permissions">
      <header class={styles.head}>
        <h2 id="chat-permissions">{t("chats.permissions")}</h2>
        <p class={styles.note}>
          {t("chats.permissionsNote")}{" "}
          <a href={DOCS} target="_blank" rel="noreferrer">
            {t("chats.permissionsDocs")}
          </a>
        </p>
      </header>

      {view.errors.length > 0 && (
        <div class={styles.alert} role="alert">
          <Alert size={16} />
          <div>
            <b>{t("chats.wouldntStart")}</b>
            <ul>
              {view.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <fieldset class={styles.group}>
        <legend>{t("chats.github")}</legend>
        <div class={styles.levels}>
          {ceiling.github.map((l) => (
            <OptionCard
              key={l.level}
              name={`github-${chatId}`}
              label={t(LEVELS[l.level])}
              help={l.reason ?? undefined}
              checked={draft.github === l.level}
              disabled={!l.allowed}
              onChange={() => set({ github: l.level })}
            />
          ))}
        </div>
      </fieldset>

      <fieldset class={styles.group}>
        <legend>{t("chats.capabilities")}</legend>
        <ul class={styles.rows}>
          {capabilities.map((c) => (
            <li key={c.name}>
              <Switch
                label={
                  <span class={styles.label}>
                    <span>
                      {NAMES[c.name] ? t(NAMES[c.name]) : c.name} <code>{c.name}</code>
                    </span>
                    <span class={styles.help}>{c.reason ?? c.what}</span>
                  </span>
                }
                checked={draft.capabilities.includes(c.name)}
                disabled={!c.allowed || c.required}
                onChange={(on) => toggle(c.name, on)}
              />
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset class={styles.group}>
        <legend>{t("chats.network")}</legend>
        {ceiling.hosts.length ? (
          <ul class={styles.rows}>
            {ceiling.hosts.map((h) => (
              <li key={h}>
                <Switch
                  label={<code>{h}</code>}
                  checked={draft.hosts.includes(h)}
                  // With the open internet, every public host is reachable: no effect then.
                  disabled={internet}
                  onChange={(on) =>
                    set({
                      hosts: ceiling.hosts.filter((x) => (x === h ? on : draft.hosts.includes(x))),
                    })
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p class={styles.note}>{t("chats.noHosts")}</p>
        )}
        <p class={styles.note}>{internet ? t("chats.internetOn") : t("chats.hostsNeeded")}</p>
      </fieldset>

      {ceiling.mounts.length > 0 && (
        <fieldset class={styles.group}>
          <legend>{t("chats.mounts")}</legend>
          <ul class={styles.rows}>
            {ceiling.mounts.map((m) => {
              const kept = draft.mounts.find((d) => d.target === m.target);
              return (
                <li key={m.target}>
                  <Switch
                    label={
                      <span class={styles.label}>
                        <code>{m.target}</code>
                        <span class={styles.help}>
                          {m.writable
                            ? t("chats.readWrite")
                            : t("chats.readOnly", { reason: m.reason ?? "" })}
                        </span>
                      </span>
                    }
                    checked={!!kept}
                    onChange={(on) =>
                      set({
                        mounts: ceiling.mounts
                          .filter((x) =>
                            x.target === m.target
                              ? on
                              : draft.mounts.some((d) => d.target === x.target),
                          )
                          .map(
                            (x) =>
                              draft.mounts.find((d) => d.target === x.target) ?? {
                                target: x.target,
                                readOnly: true,
                              },
                          ),
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {refused.length > 0 && (
        <div class={styles.alert} role="alert">
          <Alert size={16} />
          <div>
            <b>{t("chats.notSaved")}</b>
            <ul>
              {refused.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {note && (
        <p class={styles.saved} role="status">
          {note}
        </p>
      )}
      <footer class={styles.actions}>
        {view.running && (
          <Button
            onClick={restart}
            pending={pending === "restart"}
            pendingLabel={t("chats.restarting")}
          >
            {t("chats.restartNow")}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={save}
          disabled={!changed || pending !== null}
          pending={pending === "save"}
          pendingLabel={t("chats.saving")}
        >
          {t("chats.save")}
        </Button>
      </footer>
    </section>
  );
}
