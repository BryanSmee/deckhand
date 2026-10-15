// Codex (OpenAI's CLI), the second agent behind the seam (index.mjs). Its sandbox half is
// ../../sandbox/agents/codex.sh, which runs `codex exec --json` and adds, once Codex exits,
// one line of its own with the turn's outcome (`deckhand.result`): Codex's JSONL has no
// event that holds both the last message and whether the turn worked.
import { OPENAI_CREDENTIALS } from "../openai.mjs";

// Deckhand's model tiers → the pinned Codex's own catalog (`codex` lists it as best: frontier,
// balanced: the default workhorse, fast: for easier tasks). The operator can point them
// elsewhere (CODEX_BEST_MODEL…, config.codexModels), for another CODEX_VERSION say.
const MODELS = { best: "gpt-6-astra", balanced: "gpt-6.1-sol", fast: "gpt-6-luna" };
// Codex's reasoning efforts are Deckhand's.
const EFFORTS = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

// "/bin/bash -lc 'npm test'" → "npm test": how Codex runs every command.
function commandOf(command = "") {
  const wrapped = /^\/bin\/(?:ba)?sh -lc '([^]*)'$/.exec(command);
  return wrapped ? wrapped[1].replaceAll("'\\''", "'") : command;
}

function mcpText(item) {
  if (item.error) return item.error.message ?? String(item.error);
  const content = item.result?.content;
  return Array.isArray(content) ? content.map((c) => c.text ?? "").join("\n") : "";
}

// What starts (a tool call), then what it gave back once it completes.
const STARTED = {
  command_execution: (i) => [{ type: "tool", name: "command", detail: commandOf(i.command) }],
  mcp_tool_call: (i) => [
    {
      type: "tool",
      name: `mcp__${i.server}__${i.tool}`,
      detail: JSON.stringify(i.arguments ?? {}),
    },
  ],
};

const COMPLETED = {
  agent_message: (i) => [{ type: "text", text: i.text ?? "" }],
  command_execution: (i) => [
    {
      type: "toolOutput",
      error: i.status === "failed" || (i.exit_code ?? 0) !== 0,
      text: i.aggregated_output ?? "",
    },
  ],
  // Edits come whole, once applied: the call and, if it failed, its error.
  file_change: (i) => [
    {
      type: "tool",
      name: "edit",
      detail: (i.changes ?? []).map((c) => `${c.kind} ${c.path}`).join("\n"),
    },
    ...(i.status === "failed" ? [{ type: "toolOutput", error: true, text: "Not applied" }] : []),
  ],
  mcp_tool_call: (i) => [{ type: "toolOutput", error: i.status === "failed", text: mcpText(i) }],
  web_search: (i) => [{ type: "tool", name: "web_search", detail: i.query ?? "" }],
};

function itemEvents(table, item) {
  return item && Object.hasOwn(table, item.type) ? table[item.type](item) : [];
}

// Codex's JSONL event types → Deckhand's events; other types give none (turn.completed,
// turn.failed and error: the sandbox's deckhand.result says how the turn ended).
const EVENTS = {
  "thread.started": () => [{ type: "started" }],
  "item.started": (e) => itemEvents(STARTED, e.item),
  "item.completed": (e) => itemEvents(COMPLETED, e.item),
  "deckhand.result": (e) => [
    { type: "result", ok: e.ok === true, text: e.text ?? "", durationMs: e.duration_ms ?? 0 },
  ],
};

// Claude's names, which mean nothing to OpenAI: a typo'd agent or a repo's model left as it was.
const CLAUDE_MODEL = /^(opus|sonnet|haiku)(\[.*\])?$|^claude[-.]/i;

export const codex = {
  name: "codex",
  displayName: "Codex",
  // Installed per version into a shared, root-owned volume (images.installAgent()), mounted
  // read-only in sandboxes.
  install: (config) => ({
    volume: config.codexVolume,
    mount: "/opt/codex",
    version: config.codexVersion,
    versionVar: "CODEX_VERSION",
    command: "deckhand-install-codex",
  }),
  // The run's secret as its key, and the listener (openai.mjs) as its provider.
  env: (config, secret) => ({
    OPENAI_API_KEY: secret,
    OPENAI_BASE_URL: `${config.brokerUrl}/openai`,
  }),
  secrets: OPENAI_CREDENTIALS,
  // Its model calls go to the listener, and the sandbox turns off its analytics, update check
  // and plugins (agents/codex.sh): nothing else to reach.
  hosts: [],
  // CODEX_HOME, its sessions in it: a volume per issue, `<sandbox>-codex`.
  session: { volume: "codex", path: "/home/node/.codex" },
  // `codex exec` reads no more input once started: comments that arrive mid-run wait for the
  // next run, which resumes the session (tasks.mjs, deliverable()).
  takesMessages: false,
  models: (config = {}) => ({ ...MODELS, ...config.codexModels }),
  efforts: EFFORTS,
  modelProblem: (model) =>
    CLAUDE_MODEL.test(model) ? `\`${model}\` is a Claude model, not one of Codex's` : null,
  // One line of its output → Deckhand's events: started, text, tool{name, detail},
  // toolOutput{text, error}, result{ok, text, durationMs}. Lines that aren't its JSON give none.
  normalize(line) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return [];
    }
    return e && Object.hasOwn(EVENTS, e.type) ? EVENTS[e.type](e) : [];
  },
};
