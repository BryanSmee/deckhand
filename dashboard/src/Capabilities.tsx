// A repository's Capabilities tab: what each mode's runs get at their start (listener/
// capabilities.mjs), decided by the policies, greedily (allowed, asked for by .deckhand.yaml
// when a key asks for it, granted when a grant gates it), with the file that decided each one;
// what would stop a mode's runs (a broken dependency, a risky combination, a grant missing) and
// the warnings; then the catalogue. Read with the config (api/repos/<repo>/config).
import type { Tone } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { CapabilityInfo, CapabilityRow, ModeCapabilities, RepoConfig } from "./types";
import { Alert, ChevronRight, Warning } from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import styles from "./Capabilities.module.css";

const DOCS = "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#capabilities";

// What a capability's status says, as its row in a mode's details shows it (a key, written
// when shown).
const STATUSES: Record<CapabilityRow["status"], [Plain, Tone]> = {
  used: ["config.capabilityUsed", "done"],
  denied: ["config.capabilityDenied", "err"],
  "not-allowed": ["config.capabilityNotAllowed", "idle"],
  "not-asked": ["config.capabilityNotAsked", "idle"],
  "not-granted": ["config.capabilityNotGranted", "input"],
};

// The files that decided a row, as "mode-work.rego" or "repo: audit.rego".
const fileName = ({ layer, file }: CapabilityRow["files"][number]) =>
  file ?? t(layer === "repo" ? "config.ruleOfRepo" : "config.ruleOfOperator");
const filesOf = (row: CapabilityRow) =>
  row.files
    .map((f) => (f.layer === "repo" ? t("config.repoFile", { file: fileName(f) }) : fileName(f)))
    .join(t("list.comma"));

// The modes whose runs wouldn't start, for the header's badge: null when every one starts.
export function capabilityTrouble({ capabilities }: RepoConfig): string | null {
  if (capabilities.error) return t("config.capabilitiesPolicyError");
  const stopped = capabilities.modes.filter((m) => m.errors.length).length;
  return stopped ? t("config.modesStopped", { count: stopped }) : null;
}

export function Capabilities({ config }: { config: RepoConfig }) {
  const { catalogue, modes, error } = config.capabilities;
  return (
    <div class={styles.page}>
      {error && (
        <section class={styles.banner} role="alert">
          <Alert size={18} />
          <div class={styles.bannerText}>
            <b>{t("config.capabilitiesUndecided")}</b>
            <span>{error}</span>
          </div>
        </section>
      )}
      <p class={styles.model}>
        {tx("config.capabilitiesModel", {
          allow: <b>{t("config.allowRule")}</b>,
          deny: <b>{t("config.denyRule")}</b>,
          allowCapabilities: <code>allow_capabilities</code>,
          denyCapabilities: <code>deny_capabilities</code>,
          file: <code>.deckhand.yaml</code>,
        })}{" "}
        <a href={DOCS} target="_blank" rel="noreferrer">
          {t("config.capabilitiesDocs")}
        </a>
      </p>
      {modes.length > 0 && (
        <section class={styles.card} aria-labelledby="capability-modes">
          <div class={styles.cardHead}>
            <h2 id="capability-modes">{t("config.capabilitiesModes")}</h2>
            <span class={styles.note}>
              {tx("config.capabilitiesModesNote", {
                count: modes.length,
                base: <code>{config.base}</code>,
              })}
            </span>
          </div>
          <ul class={styles.modes}>
            {modes.map((m) => (
              <Mode key={m.mode} mode={m} />
            ))}
          </ul>
        </section>
      )}
      <Catalogue catalogue={catalogue} />
    </div>
  );
}

// A mode: whether its runs start, the capabilities they get and the files that gave them, what
// stops them and the warnings, then every capability, folded.
function Mode({ mode: m }: { mode: ModeCapabilities }) {
  const used = m.capabilities.filter((c) => c.used);
  const files = [...new Set(used.flatMap((c) => c.files.map(fileName)))];
  const [tone, label]: [Tone, Plain] = m.errors.length
    ? ["err", "config.modeStopped"]
    : m.warnings.length
      ? ["input", "config.modeWarned"]
      : ["done", "config.modeStarts"];
  return (
    <li class={styles.mode} aria-label={t("config.modeLabel", { mode: m.mode })}>
      <div class={styles.modeHead}>
        <span class={styles.modeName}>
          <span class={styles.key}>{m.mode}</span>
          {m.custom && <span class={styles.tag}>{t("config.modeCustom")}</span>}
        </span>
        <StatusBadge tone={tone} label={t(label)} />
      </div>
      <div class={styles.chips} aria-label={t("config.modeCapabilities")}>
        {used.length ? (
          used.map((c) => (
            <span
              key={c.name}
              class={styles.chip}
              title={t("config.allowedBy", { files: filesOf(c) })}
            >
              {c.name}
            </span>
          ))
        ) : (
          <span class={styles.note}>{t("config.modeNothing")}</span>
        )}
      </div>
      {files.length > 0 && (
        <span class={styles.note}>
          {t("config.decidedBy", { files: files.join(t("list.comma")) })}
        </span>
      )}
      {m.errors.length > 0 && (
        <ul class={styles.errors} aria-label={t("config.modeErrors")}>
          {m.errors.map((e) => (
            <li key={e}>
              <Alert size={14} />
              {e}
            </li>
          ))}
        </ul>
      )}
      {m.warnings.length > 0 && (
        <ul class={styles.warnings} aria-label={t("config.warnings")}>
          {m.warnings.map((w) => (
            <li key={w}>
              <Warning size={14} />
              {w}
            </li>
          ))}
        </ul>
      )}
      <details class={styles.details}>
        <summary>
          <span class={styles.chevron}>
            <ChevronRight size={14} />
          </span>
          {t("config.modeEvery")}
        </summary>
        <ul class={styles.rows}>
          {m.capabilities.map((c) => {
            const [name, tone] = STATUSES[c.status];
            return (
              <li key={c.name} class={styles.row}>
                <span class={styles.key}>{c.name}</span>
                <StatusBadge tone={tone} label={t(name)} />
                <span class={styles.why}>
                  {[c.reason, c.files.length ? filesOf(c) : null].filter(Boolean).join(" · ") ||
                    "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
}

// The capabilities Deckhand knows: what each gives, what it needs, what asks for it in
// .deckhand.yaml, the grant that gates it and what enforces it.
function Catalogue({ catalogue }: { catalogue: CapabilityInfo[] }) {
  return (
    <section class={styles.card} aria-labelledby="capability-catalogue">
      <div class={styles.cardHead}>
        <h2 id="capability-catalogue">{t("config.catalogueTitle")}</h2>
        <span class={styles.note}>
          {tx("config.catalogueNote", {
            pull: <code>pull</code>,
            internet: <code>internet</code>,
            both: <code>pull+internet</code>,
          })}
        </span>
      </div>
      <div class={`${styles.entry} ${styles.entryHead}`} aria-hidden="true">
        <span>{t("config.catalogueCapability")}</span>
        <span>{t("config.catalogueGives")}</span>
        <span>{t("config.catalogueNeeds")}</span>
        <span>{t("config.catalogueAsked")}</span>
        <span>{t("config.catalogueEnforced")}</span>
      </div>
      <ul class={styles.entries} aria-label={t("config.catalogueList")}>
        {catalogue.map((c) => (
          <li key={c.name} class={styles.entry}>
            <span class={styles.key}>{c.name}</span>
            <span class={styles.what}>{c.what}</span>
            <span class={styles.needs}>{c.needs.length ? c.needs.join(t("list.comma")) : "—"}</span>
            <span class={styles.asked}>
              {c.config.length
                ? c.config.join(t("config.catalogueOr"))
                : t("config.cataloguePoliciesAlone")}
              {c.grant && (
                <span class={styles.note}>{t("config.catalogueGrant", { grant: c.grant })}</span>
              )}
            </span>
            <span class={styles.enforced}>{c.enforcedBy}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
