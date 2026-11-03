// Settings › Server's Services (#560): docs/services.md's diagram, drawn here in SVG, each
// service in its state's colour with its state in words (colour is never alone), and a legend; a
// phone gets a list instead. The outside parts and the sandboxes are grey: nothing checks them.
// The state is api/health's (listener/health.mjs), which the orchestrator probes; the shell's
// alert (HealthAlert) says when a service is down or starting.
import { ago, plural, type Tone, uptime } from "./format";
import { formatRoute } from "./route";
import type { Health, ServiceHealth, ServiceName, ServiceState } from "./types";
import { StatusDot, toneClass } from "./ui/Status";
import { Card } from "./ui/Surface";
import styles from "./Health.module.css";

export const STATE_TONES: Record<ServiceState, Tone> = {
  up: "done",
  starting: "run",
  down: "err",
};

const STATE_LABELS: Record<ServiceState, string> = {
  up: "Up",
  starting: "Starting",
  down: "Down",
};

// Each service's name and what it does, as docs/services.md's diagram says them.
const SERVICES: Record<ServiceName, { label: string; role: string }> = {
  edge: { label: "edge", role: "webhooks, API, UI" },
  orchestrator: { label: "orchestrator", role: "events, tasks, queue" },
  runner: { label: "runner", role: "sandboxes, images, logs" },
  broker: { label: "broker", role: "tokens, runs' endpoints" },
  github: { label: "github", role: "GitHub's gateways" },
  models: { label: "models", role: "agents' API relay" },
  policy: { label: "policy", role: "opa, no network" },
  proxy: { label: "proxy", role: "the runs' egress" },
};

// "up 3 d 4 h", "started 2 min ago", "unreachable: timeout": by the orchestrator's clock.
export function stateText(s: ServiceHealth): string {
  if (s.state === "down") return `unreachable: ${s.reason ?? "no answer"}`;
  if (s.startedAt === null) return s.state === "up" ? "up" : "starting";
  if (s.state === "starting") return `started ${ago(s.startedAt, s.checkedAt)}`;
  return `up ${uptime(s.startedAt, s.checkedAt)}`;
}

// What the shell's dot says: the services down (red), else those starting (blue), else nothing.
export function healthAlert(health: Health | null): { tone: Tone; text: string } | null {
  if (!health) return null;
  for (const state of ["down", "starting"] as const) {
    const these = health.services.filter((s) => s.state === state).map((s) => s.name);
    if (!these.length) continue;
    const who =
      these.length > 2
        ? plural(these.length, "service")
        : these.map((n) => SERVICES[n].label).join(" and ");
    return { tone: STATE_TONES[state], text: `${who} ${state}` };
  }
  return null;
}

// The shell's alert: a dot in the state's colour, which opens the status page. Nothing while
// every service is up.
export function HealthAlert({
  health,
  class: className,
}: {
  health: Health | null;
  class?: string;
}) {
  const alert = healthAlert(health);
  if (!alert) return null;
  const label = `${alert.text[0].toUpperCase()}${alert.text.slice(1)}: see the services' status`;
  return (
    <a
      class={[styles.alert, className].filter(Boolean).join(" ")}
      href={formatRoute({ repo: null, task: null, run: null, page: "settings", section: "server" })}
      title={label}
      aria-label={label}
    >
      <StatusDot tone={alert.tone} pulse={alert.tone === "run"} />
    </a>
  );
}

// --- The diagram ---------------------------------------------------------------------------

type NodeId = ServiceName | "web" | "gh" | "ai" | "hosts" | "sandbox";

// A grid of 5 columns and 5 rows, its arrows crossing no node (straight, or bent where one
// would).
const COLS = [75, 265, 455, 645, 835];
const ROWS = [40, 135, 230, 325, 420];
const WIDTH = 910;
const HEIGHT = 460;
// Half a node's size: a service's, an outside part's.
const BOX = { w: 70, h: 28 };
const PILL = { w: 66, h: 22 };

const OUTSIDE: Record<Exclude<NodeId, ServiceName>, { label: string; role?: string }> = {
  web: { label: "GitHub webhooks", role: "and browsers" },
  gh: { label: "GitHub" },
  ai: { label: "agents' APIs" },
  hosts: { label: "granted hosts" },
  sandbox: { label: "sandboxes", role: "not checked" },
};

const PLACES: Record<NodeId, [number, number]> = {
  web: [0, 0],
  gh: [4, 0],
  edge: [0, 1],
  github: [2, 1],
  policy: [0, 2],
  orchestrator: [1, 2],
  models: [3, 2],
  ai: [4, 2],
  broker: [0, 3],
  runner: [1, 4],
  sandbox: [2, 4],
  proxy: [3, 4],
  hosts: [4, 4],
};

interface Arrow {
  from: NodeId;
  to: NodeId;
  // Bent sideways by this many steps (45 px each), left of its way for a positive one.
  bend?: number;
  // A narrow call (docs/services.md's dotted arrows), and what it is for.
  narrow?: string;
  // Both ways: the call back is drawn on the same line.
  both?: string;
}

// docs/services.md's arrows.
const ARROWS: Arrow[] = [
  { from: "web", to: "edge" },
  { from: "edge", to: "orchestrator", both: "deliveries, App" },
  { from: "edge", to: "github" },
  { from: "orchestrator", to: "runner", both: "a run's first tokens" },
  { from: "orchestrator", to: "broker" },
  { from: "runner", to: "broker" },
  { from: "runner", to: "github", narrow: "tarballs" },
  { from: "orchestrator", to: "github" },
  { from: "orchestrator", to: "policy" },
  { from: "orchestrator", to: "models" },
  { from: "runner", to: "sandbox", narrow: "starts" },
  { from: "sandbox", to: "proxy" },
  { from: "proxy", to: "github" },
  { from: "proxy", to: "models" },
  { from: "proxy", to: "broker", bend: 2 },
  { from: "proxy", to: "orchestrator", narrow: "egress policy" },
  { from: "proxy", to: "hosts" },
  { from: "github", to: "policy", bend: 1 },
  { from: "broker", to: "policy" },
  { from: "runner", to: "policy", bend: 1, narrow: "grants" },
  { from: "github", to: "gh" },
  { from: "models", to: "ai" },
  { from: "models", to: "runner", narrow: "refresh" },
];

type Point = [number, number];
const centre = (id: NodeId): Point => [COLS[PLACES[id][0]], ROWS[PLACES[id][1]]];
const half = (id: NodeId) => (id in SERVICES ? BOX : PILL);
const inside = (id: NodeId, [x, y]: Point) => {
  const [cx, cy] = centre(id);
  const { w, h } = half(id);
  return Math.abs(x - cx) <= w + 3 && Math.abs(y - cy) <= h + 3;
};

// The arrow's curve between the two nodes' borders: a quadratic Bézier from centre to centre,
// cut where it leaves the first and enters the second (its part between, by de Casteljau).
export function arrowPath({ from, to, bend = 0 }: Arrow): string {
  const p0 = centre(from);
  const p2 = centre(to);
  const [dx, dy] = [p2[0] - p0[0], p2[1] - p0[1]];
  const length = Math.hypot(dx, dy);
  const p1: Point = [
    (p0[0] + p2[0]) / 2 - (dy / length) * bend * 45,
    (p0[1] + p2[1]) / 2 + (dx / length) * bend * 45,
  ];
  const at = (t: number): Point => [
    (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
  ];
  let t0 = 0;
  while (t0 < 1 && inside(from, at(t0))) t0 += 0.005;
  let t1 = 1;
  while (t1 > t0 && inside(to, at(t1))) t1 -= 0.005;
  // The control point of the part [t0, t1].
  const c: Point = [0, 1].map(
    (i) => (1 - t0) * (1 - t1) * p0[i] + ((1 - t0) * t1 + t0 * (1 - t1)) * p1[i] + t0 * t1 * p2[i],
  ) as Point;
  const [a, b] = [at(t0), at(t1)];
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${r(a[0])} ${r(a[1])}Q${r(c[0])} ${r(c[1])} ${r(b[0])} ${r(b[1])}`;
}

function Node({ id, health }: { id: NodeId; health: Map<ServiceName, ServiceHealth> | null }) {
  const [x, y] = centre(id);
  const service = id in SERVICES ? SERVICES[id as ServiceName] : null;
  const known = service ? health?.get(id as ServiceName) : undefined;
  const { w, h } = half(id);
  const tone: Tone = known ? STATE_TONES[known.state] : "idle";
  const outside = OUTSIDE[id as keyof typeof OUTSIDE];
  const label = service?.label ?? outside.label;
  // A service: its state in words (a dash before the first answer, or "not checked" without a
  // URL); an outside part: its second line, if any.
  const second = service ? (known ? stateText(known) : health ? "not checked" : "…") : outside.role;
  return (
    <g
      class={`${styles.node} ${toneClass(tone)} ${service ? "" : styles.outside}`}
      data-service={service ? id : undefined}
      data-state={known?.state}
    >
      <title>
        {service
          ? `${label}: ${service.role}${known?.version ? ` · ${known.version}` : ""}`
          : label}
      </title>
      <rect x={x - w} y={y - h} width={w * 2} height={h * 2} rx={service ? 8 : h} />
      {service && <circle cx={x - w + 12} cy={y - 8} r={4} />}
      <text
        x={service ? x - w + 22 : x}
        y={second ? y - 4 : y + 4}
        class={styles.name}
        text-anchor={service ? "start" : "middle"}
      >
        {label}
      </text>
      {second && (
        <text
          x={service ? x - w + 12 : x}
          y={y + 13}
          class={styles.said}
          text-anchor={service ? "start" : "middle"}
        >
          {second}
        </text>
      )}
    </g>
  );
}

function Diagram({ health }: { health: Health | null }) {
  const byName = health ? new Map(health.services.map((s) => [s.name, s])) : null;
  const summary = health
    ? health.services.map((s) => `${SERVICES[s.name].label} ${stateText(s)}`).join(", ")
    : "Not checked yet";
  return (
    <svg
      class={styles.diagram}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`The services: ${summary}`}
    >
      <defs>
        <marker
          id="health-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 1L9 5L0 9z" class={styles.tip} />
        </marker>
      </defs>
      <g aria-hidden="true">
        {ARROWS.map((a) => (
          <path
            key={`${a.from}-${a.to}`}
            d={arrowPath(a)}
            class={`${styles.arrow} ${a.narrow ? styles.narrow : ""}`}
            marker-end="url(#health-arrow)"
            marker-start={a.both ? "url(#health-arrow)" : undefined}
          >
            <title>{a.narrow ?? (a.both ? `and back: ${a.both}` : "")}</title>
          </path>
        ))}
        {(Object.keys(PLACES) as NodeId[]).map((id) => (
          <Node key={id} id={id} health={byName} />
        ))}
      </g>
    </svg>
  );
}

// A phone's: one row per service, in the same colours.
function List({ health }: { health: Health | null }) {
  if (!health) return <p class={styles.empty}>Not checked yet.</p>;
  return (
    <ul class={styles.list}>
      {health.services.map((s) => (
        <li key={s.name} class={toneClass(STATE_TONES[s.state])} data-service={s.name}>
          <StatusDot tone={STATE_TONES[s.state]} />
          <span class={styles.rowName}>
            {SERVICES[s.name].label}
            <span class={styles.role}>{SERVICES[s.name].role}</span>
          </span>
          <span class={styles.rowState}>{stateText(s)}</span>
        </li>
      ))}
    </ul>
  );
}

// What the services say of their setup (their blobs taking Redis's memory, log segments waiting
// for blob storage): one row each, under its service's name. Nothing when none said anything.
function Warnings({ health }: { health: Health | null }) {
  const said = (health?.services ?? []).flatMap((s) =>
    (s.warnings ?? []).map((text) => ({ name: s.name, text })),
  );
  if (!said.length) return null;
  return (
    <ul class={`${styles.warnings} ${toneClass("input")}`} aria-label="Warnings">
      {said.map(({ name, text }) => (
        <li key={`${name}-${text}`} data-service={name}>
          <StatusDot tone="input" />
          <span>
            <span class={styles.warningName}>{SERVICES[name].label}</span> {text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Legend() {
  return (
    <ul class={styles.legend} aria-label="Legend">
      {(["up", "starting", "down"] as const).map((state) => (
        <li key={state}>
          <StatusDot tone={STATE_TONES[state]} />
          {STATE_LABELS[state]}
        </li>
      ))}
      <li>
        <StatusDot tone="idle" />
        Not checked
      </li>
    </ul>
  );
}

interface Props {
  health: Health | null;
  // Why api/health can't be read, if it can't.
  error?: string | null;
  // A phone: the list, not the diagram.
  narrow?: boolean;
}

// The card: its title, when the orchestrator last checked, the diagram (or list), the services'
// warnings and the legend.
export function Services({ health, error = null, narrow = false }: Props) {
  const checked = health
    ? new Date(health.checkedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;
  return (
    <Card as="section" aria-labelledby="server-services">
      <div class={styles.head}>
        <h2 id="server-services">Services</h2>
        <span class={styles.aside} role="status">
          {error
            ? `Couldn't check them (${error})`
            : checked
              ? `Checked at ${checked} · every 15 s`
              : "Checking…"}
        </span>
      </div>
      <div class={styles.body}>
        {narrow ? <List health={health} /> : <Diagram health={health} />}
        <Warnings health={health} />
        <Legend />
      </div>
    </Card>
  );
}
