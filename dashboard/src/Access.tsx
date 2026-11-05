// Settings › Access (#732): who may do what, read-only, for `server:read` only. Each of
// ALLOWED_USERS's actions, server-wide and on each repository the App's installations list, as
// the operator's policies decide them (`allow_access`, `deny_access`), with the files that did
// (api/access, read when the page opens), as a repository's Capabilities tab shows its own.
// Changed in the grants folder's policy/access.rego, never here.
import { useState } from "preact/hooks";
import { usePolled } from "./api";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { AccessDecision, AccessReport, UserAccess } from "./types";
import { Field } from "./ui/Field";
import { Alert, Search } from "./ui/icons";
import { Card } from "./ui/Surface";
import styles from "./Access.module.css";

const DOCS = "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#access";

// What each action lets the user do, for the chips' titles: keys, written when shown.
const ACTIONS: Record<string, Plain> = {
  "*": "config.actionAll",
  "tasks:read": "config.actionTasksRead",
  "logs:read": "config.actionLogsRead",
  "runs:manage": "config.actionRunsManage",
  "runs:start:*": "config.actionStartAll",
  "repo:config:read": "config.actionConfigRead",
  "server:read": "config.actionServerRead",
  "server:sync": "config.actionServerSync",
  "server:*": "config.actionServerAll",
};

function meaning(action: string) {
  if (ACTIONS[action]) return t(ACTIONS[action]);
  if (!action.startsWith("runs:start:")) return action;
  const mode = action.slice(11);
  return mode.endsWith("*")
    ? t("config.actionStartPrefix", { prefix: mode.slice(0, -1) })
    : t("config.actionStart", { mode });
}

// "access.rego", "repo: audit.rego", or the layer's rule without a file.
const denyFile = ({ file, layer }: AccessDecision["denied"][number]) => {
  const name = file ?? t(layer === "repo" ? "config.ruleOfRepo" : "config.ruleOfOperator");
  return layer === "repo" ? t("config.repoFile", { file: name }) : name;
};

// The row's note: the files that allowed its actions, those that denied some and why.
function noteOf(allowed: string, denied: string, reasons: string) {
  if (!denied) return t("config.accessAllowedBy", { files: allowed });
  if (!allowed)
    return reasons
      ? t("config.accessDeniedByWhy", { files: denied, reasons })
      : t("config.accessDeniedBy", { files: denied });
  return reasons
    ? t("config.accessBothWhy", { allowed, denied, reasons })
    : t("config.accessBoth", { allowed, denied });
}

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
        {tx("config.accessModel", {
          allow: <b>{t("config.allowRule")}</b>,
          deny: <b>{t("config.denyRule")}</b>,
          allowAccess: <code>allow_access</code>,
          bindings: <code>bindings</code>,
          denyAccess: <code>deny_access</code>,
          repoPolicy: <code>.deckhand/policy/</code>,
          allowedUsers: <code>ALLOWED_USERS</code>,
          users: <code>users</code>,
          accessRego: <code>policy/access.rego</code>,
        })}{" "}
        <a href={DOCS} target="_blank" rel="noreferrer">
          {t("config.accessDocs")}
        </a>
      </p>
      {(report.error || data?.error) && (
        <section class={styles.banner} role="alert">
          <Alert size={18} />
          <span>
            {report.error
              ? t("config.accessUnreadable", { error: report.error })
              : t("config.accessServerOnly", { error: data!.error ?? "" })}
          </span>
        </section>
      )}
      {data && (
        <Field
          class={styles.filter}
          label={t("config.accessFilter")}
          hideLabel
          size="small"
          lead={<Search size={14} />}
          placeholder={t("config.accessFilter")}
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      )}
      {!data && !report.error && <p class={styles.empty}>{t("config.accessLoading")}</p>}
      {data && !shown.length && (
        <p class={styles.empty}>{t(words ? "config.accessNoMatch" : "config.accessNoLogin")}</p>
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
          {seen ? t("config.accessRepos", { count: seen }) : t("config.accessNoRepo")}
        </span>
      </div>
      <ul class={styles.rows} aria-label={t("config.accessActions", { login: u.login })}>
        <Row name={t("config.accessServerWide")} decision={u.server} />
        {rows.map((r) => (
          <Row key={r.repo} name={r.repo} decision={r} mono />
        ))}
      </ul>
      {(none.length > 0 || outside.length > 0) && (
        <div class={styles.foot}>
          {none.length > 0 && (
            <span>
              {tx("config.accessNoActionOn", {
                repos: <span class={styles.mono}>{none.join(", ")}</span>,
              })}
            </span>
          )}
          {outside.length > 0 && (
            <span>
              {tx("config.accessOutside", {
                users: <code>users</code>,
                repos: <span class={styles.mono}>{outside.join(", ")}</span>,
              })}
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
          <span class={styles.bad}>{t("config.accessUndecided", { error: d.error })}</span>
        ) : (
          <>
            <span class={styles.chips}>
              {d.actions.length === 0 && (
                <span class={styles.note}>{t("config.accessNoAction")}</span>
              )}
              {d.actions.map((a) => (
                <span
                  key={a.action}
                  class={styles.chip}
                  title={
                    a.files.length
                      ? t("config.accessChipAllowed", {
                          meaning: meaning(a.action),
                          files: a.files.join(", "),
                        })
                      : meaning(a.action)
                  }
                >
                  {a.action}
                </span>
              ))}
              {d.denied.map((x) => (
                <span
                  key={`${x.action} ${x.file}`}
                  class={`${styles.chip} ${styles.denied}`}
                  title={
                    x.reason
                      ? t("config.accessChipDeniedWhy", { file: denyFile(x), reason: x.reason })
                      : t("config.accessChipDenied", { file: denyFile(x) })
                  }
                >
                  {x.action}
                </span>
              ))}
            </span>
            {(files.length > 0 || d.denied.length > 0) && (
              <span class={styles.note}>
                {noteOf(
                  files.join(", "),
                  [...new Set(d.denied.map(denyFile))].join(", "),
                  [...new Set(d.denied.map((x) => x.reason).filter(Boolean))].join("; "),
                )}
              </span>
            )}
          </>
        )}
      </span>
    </li>
  );
}
