// New request, from the sidebar's menu: ask a repository for something. The kind first (an
// idea or a bug report for its inbox, a discussion when a repo has a category for them, or a
// run that analyzes its recent runs), then the repository (the page's when it is offered),
// then the kind's form: Inbox.tsx or Analyze.tsx. The footer's main action is the form's: it
// says what it does, and Ctrl Enter sends it.
import { useId, useState } from "preact/hooks";
import { type Can, useCan } from "./access";
import { analysisRepos, AnalyzeForm } from "./Analyze";
import { sameRepo, uniqueRepos } from "./format";
import { t } from "./i18n";
import { INBOX_DOCS, InboxForm, type InboxKind } from "./Inbox";
import type { Plain } from "./locales";
import type { Inboxes, Task } from "./types";
import { Button } from "./ui/Button";
import { type Segment, Segmented } from "./ui/Choice";
import { Dialog } from "./ui/Dialog";
import { Field } from "./ui/Field";
import * as Icon from "./ui/icons";
import styles from "./NewRequest.module.css";

export type RequestKind = InboxKind | "analyze";

// What a form puts in the footer: its main action.
export interface Action {
  label: string;
  pendingLabel: string;
  disabled: boolean;
  pending: boolean;
}

// Each inbox kind's key in .deckhand.yaml's `inboxes`, and the sentences that name it: whole
// sentences, so a language can write each kind's name as its sentence needs.
const INBOX: Record<
  InboxKind,
  { key: keyof Inboxes; cantSend: Plain; noInbox: Plain; repoNoInbox: RepoNoInbox }
> = {
  idea: {
    key: "ideas",
    cantSend: "request.cantSendIdeas",
    noInbox: "request.noIdeas",
    repoNoInbox: "request.repoNoIdeas",
  },
  bug: {
    key: "bugs",
    cantSend: "request.cantSendBugs",
    noInbox: "request.noBugs",
    repoNoInbox: "request.repoNoBugs",
  },
  discussion: {
    key: "discussions",
    cantSend: "request.cantSendDiscussions",
    noInbox: "request.noDiscussions",
    repoNoInbox: "request.repoNoDiscussions",
  },
};
type RepoNoInbox = "request.repoNoIdeas" | "request.repoNoBugs" | "request.repoNoDiscussions";

const SUBS: Record<RequestKind, Plain> = {
  idea: "request.subInbox",
  bug: "request.subInbox",
  discussion: "request.subDiscussion",
  analyze: "request.subAnalyze",
};

// The kinds in the order the dialog offers them.
const KINDS: RequestKind[] = ["idea", "bug", "discussion", "analyze"];

// The kinds the user may send somewhere (access.ts: `runs:start:<kind>`, each one a mode).
export const requestKinds = (can: Can) => KINDS.filter((k) => can.anywhere(k));

// The repos with an inbox of that kind, by name.
export const inboxRepos = (inboxes: Record<string, Inboxes> | undefined, kind: InboxKind) =>
  uniqueRepos(Object.keys(inboxes ?? {}).filter((r) => inboxes![r][INBOX[kind].key])).sort();

interface Props {
  // The menu's pick: the kind it opens on.
  kind: RequestKind;
  // api/state's: the repos whose config the listener has read.
  inboxes: Record<string, Inboxes> | undefined;
  tasks: Task[];
  // The page's repo: picked first when it is offered.
  repo: string | null;
  // An idea's or a bug report's title, already typed (Ctrl K's "New idea: “…”").
  title?: string;
  onClose: () => void;
  // Once sent: api/state read again, for the run.
  onSent?: () => void;
}

export function NewRequest({
  kind: first,
  inboxes,
  tasks,
  repo: tab,
  title,
  onClose,
  onSent,
}: Props) {
  // What the user may send, and where (access.ts): the other kinds and repos aren't offered.
  const can = useCan();
  const allowed = requestKinds(can);
  const [kind, setKind] = useState<RequestKind>(() =>
    allowed.includes(first) ? first : (allowed[0] ?? first),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const formId = useId();

  const offered = kind === "analyze" ? analysisRepos(inboxes, tasks) : inboxRepos(inboxes, kind);
  const repos = offered.filter((r) => can.start(r, kind));
  const repo =
    repos.find((r) => sameRepo(r, picked)) ??
    repos.find((r) => sameRepo(r, tab)) ??
    repos[0] ??
    null;
  const anyDiscussions = inboxRepos(inboxes, "discussion").length > 0;
  const kinds: Segment<RequestKind>[] = (
    [
      { value: "idea", label: t("request.kindIdea"), icon: <Icon.Idea size={14} /> },
      { value: "bug", label: t("request.kindBug"), icon: <Icon.Bug size={14} /> },
      ...(anyDiscussions || kind === "discussion"
        ? [
            {
              value: "discussion" as const,
              label: t("request.kindDiscussion"),
              icon: <Icon.Talk size={14} />,
            },
          ]
        : []),
      { value: "analyze", label: t("request.kindAnalyze"), icon: <Icon.Chart size={14} /> },
    ] as Segment<RequestKind>[]
  ).filter((k) => allowed.includes(k.value) || k.value === kind);

  // The page's repo, read and without this inbox: said, with the way to set one up.
  const read = Object.keys(inboxes ?? {}).find((r) => sameRepo(r, tab));
  const without = kind !== "analyze" && read && !inboxes![read][INBOX[kind].key] ? tab : null;
  const note =
    offered.length > 0 && !repos.length ? (
      <p class={styles.note}>
        {kind === "analyze" ? t("request.cantAnalyze") : t(INBOX[kind].cantSend)}
      </p>
    ) : kind === "analyze" ? (
      !repos.length && <p class={styles.note}>{t("request.nothingToAnalyze")}</p>
    ) : without || !repos.length ? (
      <p class={styles.note}>
        {without
          ? t(INBOX[kind].repoNoInbox, { repo: without })
          : inboxes
            ? t(INBOX[kind].noInbox)
            : t("request.loading")}{" "}
        {inboxes && (
          <a href={INBOX_DOCS} target="_blank" rel="noreferrer">
            {t("request.setUp")}
          </a>
        )}
      </p>
    ) : null;

  const send = () => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    form?.requestSubmit();
  };

  return (
    <Dialog
      title={t("request.title")}
      sub={t(SUBS[kind])}
      onClose={onClose}
      onSubmit={repo ? send : undefined}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("request.cancel")}
          </Button>
          {repo && action && (
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={action.disabled}
              pending={action.pending}
              pendingLabel={action.pendingLabel}
            >
              {action.label}
            </Button>
          )}
        </>
      }
    >
      <Segmented
        label={t("request.kind")}
        class={styles.kinds}
        options={kinds}
        value={kind}
        onChange={(next) => {
          setAction(null);
          setKind(next);
        }}
      />
      {note}
      {repo && (
        <Field
          as="select"
          label={t("request.repository")}
          value={repo}
          onChange={(e) => setPicked(e.currentTarget.value)}
        >
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Field>
      )}
      {repo &&
        (kind === "analyze" ? (
          <AnalyzeForm
            key={repo}
            id={formId}
            repo={repo}
            tasks={tasks}
            onAction={setAction}
            onSent={onSent}
          />
        ) : (
          <InboxForm
            id={formId}
            repo={repo}
            kind={kind}
            inboxes={inboxes![repo]}
            tasks={tasks}
            onAction={setAction}
            onSent={onSent}
            title={title}
          />
        ))}
    </Dialog>
  );
}
