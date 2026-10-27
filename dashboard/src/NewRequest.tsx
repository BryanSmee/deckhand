// New request, from the sidebar's menu: ask a repository for something. The kind first (an
// idea or a bug report for its inbox, a discussion when a repo has a category for them, or a
// run that analyzes its recent runs), then the repository (the page's when it is offered),
// then the kind's form: Inbox.tsx or Analyze.tsx. The footer's main action is the form's: it
// says what it does, and Ctrl Enter sends it.
import { useId, useState } from "preact/hooks";
import { analysisRepos, AnalyzeForm } from "./Analyze";
import { sameRepo, uniqueRepos } from "./format";
import { INBOX_DOCS, InboxForm, type InboxKind } from "./Inbox";
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

// Each inbox kind's key in .deckhand.yaml's `inboxes`, and its name in a sentence.
const INBOX: Record<InboxKind, { key: keyof Inboxes; name: string }> = {
  idea: { key: "ideas", name: "ideas" },
  bug: { key: "bugs", name: "bug reports" },
  discussion: { key: "discussions", name: "discussions" },
};

const SUBS: Record<RequestKind, string> = {
  idea: "Goes to its repository's inbox, for the inbox run to pick up.",
  bug: "Goes to its repository's inbox, for the inbox run to pick up.",
  discussion: "Starts a discussion in its repository: Deckhand answers there.",
  analyze:
    "A run reads a digest of the runs you pick and replies on a new issue with what would make them faster or more reliable. It changes no code.",
};

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
  const [kind, setKind] = useState<RequestKind>(first);
  const [picked, setPicked] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const formId = useId();

  const repos = kind === "analyze" ? analysisRepos(inboxes, tasks) : inboxRepos(inboxes, kind);
  const repo =
    repos.find((r) => sameRepo(r, picked)) ??
    repos.find((r) => sameRepo(r, tab)) ??
    repos[0] ??
    null;
  const anyDiscussions = inboxRepos(inboxes, "discussion").length > 0;
  const kinds: Segment<RequestKind>[] = [
    { value: "idea", label: "Idea", icon: <Icon.Idea size={14} /> },
    { value: "bug", label: "Bug report", icon: <Icon.Bug size={14} /> },
    ...(anyDiscussions || kind === "discussion"
      ? [{ value: "discussion" as const, label: "Discussion", icon: <Icon.Talk size={14} /> }]
      : []),
    { value: "analyze", label: "Analyze runs", icon: <Icon.Chart size={14} /> },
  ];

  // The page's repo, read and without this inbox: said, with the way to set one up.
  const read = Object.keys(inboxes ?? {}).find((r) => sameRepo(r, tab));
  const without = kind !== "analyze" && read && !inboxes![read][INBOX[kind].key] ? tab : null;
  const note =
    kind === "analyze" ? (
      !repos.length && <p class={styles.note}>No repository has runs to analyze yet.</p>
    ) : without || !repos.length ? (
      <p class={styles.note}>
        {without
          ? `${without} has no inbox for ${INBOX[kind].name}.`
          : inboxes
            ? `No repository has an inbox for ${INBOX[kind].name}.`
            : "Loading…"}{" "}
        {inboxes && (
          <a href={INBOX_DOCS} target="_blank" rel="noreferrer">
            Set one up
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
      title="New request"
      sub={SUBS[kind]}
      onClose={onClose}
      onSubmit={repo ? send : undefined}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
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
        label="Kind"
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
          label="Repository"
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
