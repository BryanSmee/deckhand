// Every component in both themes (docs/design/dashboard-redesign.md › Components): a page to
// look at while building one (`npm run dev`, then #/gallery). Never in the build (main.tsx).
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { Tone } from "../format";
import { Button, IconButton } from "./Button";
import { Checkbox, OptionCard, Segmented, Switch } from "./Choice";
import { Count } from "./Count";
import { Dialog } from "./Dialog";
import { Field } from "./Field";
import { FilterChip } from "./FilterChip";
import { Fold } from "./Fold";
import * as Icon from "./icons";
import { Kbd } from "./Kbd";
import { NavItem } from "./NavItem";
import { Spinner } from "./Spinner";
import { StatusBadge, StatusDot } from "./Status";
import { Card, Notice, Skeleton, Toast } from "./Surface";
import { Tabs } from "./Tabs";
import { ThemeSwitch } from "./ThemeSwitch";
import styles from "./Gallery.module.css";

export function Gallery() {
  return (
    <div class={styles.page}>
      <header class={styles.header}>
        <div>
          <h1>Components</h1>
          <p>dashboard/src/ui: every view composes these instead of styling its own.</p>
        </div>
        <ThemeSwitch />
      </header>
      <div class={styles.themes}>
        <Theme name="Light" class="t-light" />
        <Theme name="Dark" class="t-dark" />
      </div>
    </div>
  );
}

const TONES: Tone[] = ["run", "input", "ready", "done", "err", "idle"];

function Theme({ name, class: theme }: { name: string; class: string }) {
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<"graph" | "lanes">("graph");
  const [chip, setChip] = useState("input");
  const [tab, setTab] = useState<"backlog" | "brainstorm" | "waiting" | "answers">("backlog");
  const [closed, setClosed] = useState(true);
  const [first, setFirst] = useState(true);
  const [answer, setAnswer] = useState("yes");
  const [dialog, setDialog] = useState(false);
  const start = () => {
    setPending(true);
    setTimeout(() => setPending(false), 2500);
  };
  return (
    <div class={`${styles.theme} ${theme}`}>
      <h2>{name}</h2>

      <section class={styles.section}>
        <h3>Buttons</h3>
        <div class={styles.row}>
          <Button variant="primary" icon={<Icon.Play size={14} />}>
            Start
          </Button>
          <Button>Queue after…</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon={<Icon.Stop size={12} />}>
            Stop
          </Button>
          <IconButton label="Sync with GitHub" icon={<Icon.Sync />} />
          <IconButton variant="ghost" label="More actions" icon={<Icon.More />} />
        </div>
        <div class={styles.row}>
          <span class={styles.help}>Pending, no label (click):</span>
          <Button pending={pending} onClick={start}>
            Send
          </Button>
          <Button pending={pending} icon={<Icon.Sync size={14} />} onClick={start}>
            Sync
          </Button>
          <IconButton
            label="Sync with GitHub"
            icon={<Icon.Sync />}
            pending={pending}
            onClick={start}
          />
        </div>
        <div class={styles.states}>
          <span class={styles.help}>State</span>
          <span class={styles.help}>Default</span>
          <span class={styles.help}>Disabled</span>
          <span class={styles.help}>Pending</span>
          <span class={styles.help}>Try it</span>
          {(["primary", "secondary"] as const).map((variant) => (
            <Fragment key={variant}>
              <span class={styles.help}>{variant === "primary" ? "Primary" : "Secondary"}</span>
              <Button variant={variant} size="small">
                Start
              </Button>
              <Button variant={variant} size="small" disabled>
                Start
              </Button>
              <Button variant={variant} size="small" pending pendingLabel="Starting…">
                Start
              </Button>
              <Button
                variant={variant}
                size="small"
                pending={pending}
                pendingLabel="Starting…"
                onClick={start}
              >
                Start
              </Button>
            </Fragment>
          ))}
        </div>
        <div class={styles.row}>
          <Button size="small">Small · 28</Button>
          <Button>Default · 36</Button>
          <Button size="touch">Touch · 44</Button>
          <span class={styles.help}>Stop's question:</span>
          <Button size="small" variant="ghost">
            Keep running
          </Button>
          <Button size="small" variant="danger-solid">
            Stop the run
          </Button>
        </div>
      </section>

      <section class={styles.section}>
        <h3>Fields</h3>
        <div class={styles.grid}>
          <Field as="select" label="Repository" help="Where the idea or bug report goes.">
            <option>acme/app</option>
            <option>acme/api</option>
          </Field>
          <Field
            label="Filter issues"
            lead={<Icon.Search size={15} />}
            hint="/"
            placeholder="Search tasks"
          />
          <Field
            label="Title"
            placeholder="What should happen?"
            error="A title is needed to file it."
          />
          <Field as="select" label="Start in" disabled help="Disabled: the config has errors.">
            <option>work</option>
          </Field>
          <Field as="textarea" label="Details" rows={3} placeholder="Markdown works." />
        </div>
        <div class={styles.row}>
          <Checkbox label="Open questions first" checked={first} onChange={setFirst} />
          <Switch label="Show closed" checked={closed} onChange={setClosed} />
          <Segmented
            label="Board view"
            value={view}
            onChange={setView}
            options={[
              { value: "graph", label: "Graph" },
              { value: "lanes", label: "Lanes" },
            ]}
          />
          <Segmented
            label="Pages"
            value="tasks"
            options={[
              { value: "tasks", label: "Tasks", href: "#/gallery", icon: <Icon.Tasks size={14} /> },
              { value: "board", label: "Board", href: "#/gallery", icon: <Icon.Board size={14} /> },
            ]}
          />
        </div>
        <div class={styles.grid}>
          {[
            ["yes", "Yes, every run counts"],
            ["no", "No, only new work"],
          ].map(([value, label]) => (
            <OptionCard
              key={value}
              name={`answer-${theme}`}
              value={value}
              checked={answer === value}
              onChange={() => setAnswer(value)}
              label={label}
              help={value === "yes" ? "Recommended" : undefined}
            />
          ))}
        </div>
      </section>

      <section class={styles.section}>
        <h3>Status</h3>
        <div class={styles.row}>
          <StatusBadge state="scheduled" />
          <StatusBadge state="working" />
          <StatusBadge state="building-image" />
          <StatusBadge state="needs-input" />
          <StatusBadge state="brainstorm" />
          <StatusBadge tone="ready" label="Ready for review" />
          <StatusBadge state="done" />
          <StatusBadge state="error" />
          <StatusBadge state="queued" />
          <StatusBadge state="waiting" label="After #23" />
        </div>
        <div class={styles.row}>
          {TONES.map((tone) => (
            <StatusDot key={tone} tone={tone} label={tone} />
          ))}
          <span class={styles.help}>A dot alone names itself; running pulses.</span>
        </div>
      </section>

      <section class={styles.section}>
        <h3>Filters, tabs, navigation</h3>
        <div class={styles.row}>
          {[
            ["all", "All", 11],
            ["running", "Running", 3],
            ["input", "Needs you", 2],
            ["ready", "Ready", 1],
            ["done", "Done", 4],
            ["error", "Error", 1],
          ].map(([id, label, n]) => (
            <FilterChip
              key={id}
              pressed={chip === id}
              count={n as number}
              onClick={() => setChip(id as string)}
            >
              {label}
            </FilterChip>
          ))}
        </div>
        <Tabs
          label="Work queue"
          selected={tab}
          onSelect={setTab}
          tabs={[
            { id: "backlog", label: "Backlog", count: 12 },
            { id: "brainstorm", label: "Brainstorm", count: 1 },
            { id: "waiting", label: "Waiting", count: 3 },
            { id: "answers", label: "Answers", count: 1, hot: true },
          ]}
        />
        <nav class={styles.nav} aria-label={`Sample navigation, ${name}`}>
          <NavItem href="#/gallery" icon={<Icon.Tasks />} label="Tasks" current />
          <NavItem href="#/gallery" icon={<Icon.Board />} label="Board" />
          <NavItem href="#/gallery" icon={<Icon.Settings />} label="Settings" count={2} hot />
        </nav>
        <nav class={styles.row} aria-label={`Sample rail, ${name}`}>
          <NavItem href="#/gallery" icon={<Icon.Overview />} label="Overview" rail current />
          <NavItem href="#/gallery" icon={<Icon.Tasks />} label="Tasks" rail />
          <NavItem href="#/gallery" icon={<Icon.Settings />} label="Settings" rail count={2} hot />
          <Count n={4} />
          <Count n={1} hot />
        </nav>
      </section>

      <section class={styles.section}>
        <h3>Feedback</h3>
        <Notice tone="done">Queued #24 after #23.</Notice>
        <Notice tone="err">
          acme/app's .deckhand.yaml has errors: nothing starts until they are fixed.{" "}
          <a href="#/gallery">Open settings</a>
        </Notice>
        <Notice tone="input">#21 has 3 open questions.</Notice>
        <div class={styles.row}>
          <Toast
            action={
              <Button size="small" variant="secondary">
                View
              </Button>
            }
          >
            Rerun queued for #16
          </Toast>
          <Spinner />
          <div class={styles.skeleton}>
            <Skeleton />
            <Skeleton width="64%" />
          </div>
          <span class={styles.help}>
            Search <Kbd>/</Kbd> · Close <Kbd>Esc</Kbd>
          </span>
        </div>
      </section>

      <section class={styles.section}>
        <h3>Surfaces</h3>
        <Card class={styles.card}>A card: a panel's surface, its border and radius.</Card>
        <Card class={styles.folds}>
          <Fold title="Setup" tone="done" meta="6s">
            <p class={styles.line}>Sandbox acme-app-19 · network through the egress proxy</p>
          </Fold>
          <Fold title="Work" tone="err" meta={<StatusBadge tone="err" label="1 failed" />} open>
            <p class={styles.line}>I'll add exponential backoff to the delivery queue.</p>
            <Fold title="Read · 5 files" meta="14:04">
              <p class={styles.line}>listener/deliveries.mjs, listener/tasks.mjs, …</p>
            </Fold>
          </Fold>
        </Card>
        <div class={styles.row}>
          <Button onClick={() => setDialog(true)}>Open a dialog</Button>
        </div>
        {dialog && (
          <div class={theme}>
            <Dialog
              title="New request"
              sub="Files an issue for its repository's inbox run to pick up."
              onClose={() => setDialog(false)}
              onSubmit={() => setDialog(false)}
              actions={
                <>
                  <Button variant="ghost" onClick={() => setDialog(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => setDialog(false)}>
                    Send idea
                  </Button>
                </>
              }
            >
              <Field label="Title" placeholder="What should happen?" />
              <Field as="textarea" label="Details" rows={4} />
            </Dialog>
          </div>
        )}
      </section>
    </div>
  );
}
