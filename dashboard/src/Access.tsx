// Settings › Access (#732): who may do what, read-only, for `server:read` only. Each of
// ALLOWED_USERS's actions, server-wide and on each repository the App's installations list, as
// the operator's policies decide them (`allow_access`, `deny_access`), with the files that did
// (api/access, read when the page opens), as a repository's Capabilities tab shows its own.
// Changed in the grants folder's policy/access.rego, never here.
import { useState } from "preact/hooks";
import { usePolled } from "./api";
import { plural } from "./format";
import type { AccessDecision, AccessReport, UserAccess } from "./types";
import { Field } from "./ui/Field";
import { Alert, Search } from "./ui/icons";
import { Card } from "./ui/Surface";
import styles from "./Access.module.css";

const DOCS = "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#access";

// What each action lets the user do, for the chips' titles.
const ACTIONS: Record<string, string> = {
  "*": "every action",
  "tasks:read": "sees its tasks and runs",
  "logs:read": "reads its runs' logs",
  "runs:manage": "stops, reruns, answers, dismisses, orders and names lanes",
  "runs:start:*": "starts runs in every mode",
  "repo:config:read": "reads its config and onboards it",
  "server:read": "reads Settings › Server and Access, the health and the plans",
  "server:sync": "syncs with GitHub",
  "server:*": "every server-wide action",
};

const meaning = (action: string) =>
  ACTIONS[action] ??
  (action.startsWith("runs:start:")
    ? `starts runs in ${action.endsWith("*") ? "the modes starting with " : ""}${action.slice(11).replace(/\*$/, "")}`
    : action);

// "access.rego", "repo: audit.rego", or the layer's rule without a file.
const denyFile = ({ file, layer }: AccessDecision["denied"][number]) =>
  `${layer === "repo" ? "repo: " : ""}${file ?? `a rule of the ${layer === "repo" ? "repo's" : "operator's"}`}`;

// Whether a decision gives or takes anything, or says why it can't.
const said = (d: AccessDecision) => d.actions.length > 0 || d.denied.length > 0 || !!d.error;

export function Access() {
  const report = usePolled<AccessReport>("api/access", null);
  const [filter, setFilter] = useState("");
  const words = filter.trim().toLowerCase();
  const data = report.data;
  // A login matching shows whole; else only the repositories matching.
  const shown = (data?.users ?? [])
    .map((u) =>
      !words || u.login.toLowerCase().includes(words)
        ? u
        : { ...u, repos: u.repos.filter((r) => r.repo.toLowerCase().includes(words)) },
    )
    .filter((u) => !words || u.login.toLowerCase().includes(words) || u.repos.length > 0);
  return (
    <div class={styles.page}>
      <p class={styles.model}>
        Who may do what is the operator's policies' to say: a login has an action where an{" "}
        <b>allow</b> rule of theirs gives it (<code>allow_access</code>, a role's{" "}
        <code>bindings</code>) and no <b>deny</b> rule takes it away (<code>deny_access</code>, the
        operator's or the repository's <code>.deckhand/policy/</code>), within{" "}
        <code>ALLOWED_USERS</code> and the repository's <code>users</code>. A repository with no
        action is hidden from that login. Read only: the grants folder's{" "}
        <code>policy/access.rego</code> changes it.{" "}
        <a href={DOCS} target="_blank" rel="noreferrer">
          How access works
        </a>
      </p>
      {(report.error || data?.error) && (
        <section class={styles.banner} role="alert">
          <Alert size={18} />
          <span>
            {report.error
              ? `Can't read who has what (${report.error}).`
              : `Only the server-wide actions: ${data!.error}.`}
          </span>
        </section>
      )}
      {data && (
        <Field
          class={styles.filter}
          label="Filter by login or repository"
          hideLabel
          size="small"
          lead={<Search size={14} />}
          placeholder="Filter by login or repository"
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      )}
      {!data && !report.error && <p class={styles.empty}>Loading…</p>}
      {data && !shown.length && (
        <p class={styles.empty}>{words ? "No login or repository matches." : "No login."}</p>
      )}
      {shown.map((u) => (
        <User key={u.login} user={u} />
      ))}
    </div>
  );
}

// A login's card: its server-wide actions, then each repository it has some action on (or that
// denies one, or can't be decided), and those it has none on, in a line.
function User({ user: u }: { user: UserAccess }) {
  const rows = u.repos.filter(said);
  const outside = u.repos.filter((r) => r.outside).map((r) => r.repo);
  const none = u.repos.filter((r) => !said(r) && !r.outside).map((r) => r.repo);
  const seen = rows.filter((r) => r.actions.length > 0 && !r.error).length;
  const id = `access-${u.login}`;
  return (
    <Card as="section" class={styles.user} aria-labelledby={id}>
      <div class={styles.head}>
        <h2 id={id}>@{u.login}</h2>
        <span class={styles.note}>
          {seen ? `${plural(seen, "repository", "repositories")} with access` : "No repository"}
        </span>
      </div>
      <ul class={styles.rows} aria-label={`@${u.login}'s actions`}>
        <Row name="Server-wide" decision={u.server} />
        {rows.map((r) => (
          <Row key={r.repo} name={r.repo} decision={r} mono />
        ))}
      </ul>
      {(none.length > 0 || outside.length > 0) && (
        <div class={styles.foot}>
          {none.length > 0 && (
            <span>
              No action on <span class={styles.mono}>{none.join(", ")}</span>
            </span>
          )}
          {outside.length > 0 && (
            <span>
              Not in the <code>users</code> of <span class={styles.mono}>{outside.join(", ")}</span>
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

// A repository's (or the server's) decision: the actions given, each titled with what it lets
// the login do and the files that gave it; the denies, struck, with theirs and why.
function Row({
  name,
  decision: d,
  mono = false,
}: {
  name: string;
  decision: AccessDecision;
  mono?: boolean;
}) {
  const files = [...new Set(d.actions.flatMap((a) => a.files))];
  return (
    <li class={styles.row}>
      <span class={`${styles.name} ${mono ? styles.mono : ""}`}>{name}</span>
      <span class={styles.what}>
        {d.error ? (
          <span class={styles.bad}>Can't be decided: nothing given ({d.error})</span>
        ) : (
          <>
            <span class={styles.chips}>
              {d.actions.length === 0 && <span class={styles.note}>No action</span>}
              {d.actions.map((a) => (
                <span
                  key={a.action}
                  class={styles.chip}
                  title={`${meaning(a.action)}${a.files.length ? ` · allowed by ${a.files.join(", ")}` : ""}`}
                >
                  {a.action}
                </span>
              ))}
              {d.denied.map((x) => (
                <span
                  key={`${x.action} ${x.file}`}
                  class={`${styles.chip} ${styles.denied}`}
                  title={`Denied by ${denyFile(x)}${x.reason ? `: ${x.reason}` : ""}`}
                >
                  {x.action}
                </span>
              ))}
            </span>
            {(files.length > 0 || d.denied.length > 0) && (
              <span class={styles.note}>
                {files.length > 0 && `Allowed by ${files.join(", ")}`}
                {files.length > 0 && d.denied.length > 0 && " · "}
                {d.denied.length > 0 &&
                  `denied by ${[...new Set(d.denied.map(denyFile))].join(", ")}${d.denied.some((x) => x.reason) ? `: ${[...new Set(d.denied.map((x) => x.reason).filter(Boolean))].join("; ")}` : ""}`}
              </span>
            )}
          </>
        )}
      </span>
    </li>
  );
}
