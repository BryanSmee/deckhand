// Antigravity CLI (`agy`, Google's), the third agent behind the seam (index.mjs), on a Google AI
// Pro/Ultra plan. Its sandbox half is ../../sandbox/agents/antigravity.sh, which runs
// `agy -p … --output-format stream-json` and joins an answer's text deltas into one line of its
// own (`deckhand.text`, antigravity/text.jq): the dashboard shows a message, not its pieces.
//
// With a GEMINI_API_KEY, the sandbox gets the run's secret as GEMINI_API_KEY and
// GOOGLE_GEMINI_BASE_URL=<broker>/google (google.mjs). With a Google AI plan's login instead
// (antigravity-login.mjs), `agy` has no base URL: the sandbox's token file holds the run's
// secret, and the proxy hands the hosts that carry it (`relayed`) to the listener (google.mjs),
// which puts the plan's access token in its place. Security model: ../../docs/security.md.
import { GOOGLE_CREDENTIALS } from "../google.mjs";
import { installSpec, normalizer } from "./common.mjs";

// Deckhand's tiers → the plan's models (`agy models` lists them, each with its effort as a
// suffix; on a Gemini API key, antigravity.sh declares Argon itself). The operator can point
// them elsewhere (AGY_BEST_MODEL…, config.agyModels).
const MODELS = {
  best: "gemini-4-argon-high",
  balanced: "gemini-4-argon-medium",
  fast: "gemini-3.8-flash-medium",
};

// A model named without its suffix (`gemini-4-argon`) takes the run's effort as one
// (antigravity.sh): the plan has low, medium and high.
const EFFORTS = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

// What the token's hosts are, and what else `agy` calls (checked against agy 1.4.0): its feature
// flags and the account's avatar, which carry no token, stay a tunnel (its eligibility check
// stops without the avatar, #224). Telemetry, which carries the token, is refused, whatever the
// grants say.
export const RELAYED = ["daily-cloudcode-pa.googleapis.com", "www.googleapis.com"];
const BLOCKED = ["play.googleapis.com"];

// A step's tool call → Deckhand's name and what it is about.
const TOOLS = {
  run_command: (p) => ["command", p.CommandLine ?? ""],
  write_to_file: (p) => ["edit", p.TargetFile ?? ""],
  replace_file_content: (p) => ["edit", p.TargetFile ?? ""],
  multi_replace_file_content: (p) => ["edit", p.TargetFile ?? ""],
  sed_file: (p) => ["edit", p.TargetFile ?? ""],
  call_mcp_tool: (p) => [`mcp__${p.ServerName}__${p.ToolName}`, JSON.stringify(p.Arguments ?? {})],
};

function toolOf(info = {}) {
  const name = info.name ?? "tool";
  const parameters = info.parameters ?? {};
  if (Object.hasOwn(TOOLS, name)) return TOOLS[name](parameters);
  const first = Object.values(parameters).find((v) => typeof v === "string");
  return [name, first ?? (Object.keys(parameters).length ? JSON.stringify(parameters) : "")];
}

// A tool step starts (ACTIVE), then ends with its output, if it has any. Its output says
// nothing of a failed command (`false` gives no exit code): only a step that didn't end as
// DONE is an error.
function stepEvents(s = {}) {
  if (s.step_type !== "tool") return [];
  if (s.state === "ACTIVE") {
    const [name, detail] = toolOf(s.tool_info);
    return [{ type: "tool", name, detail }];
  }
  const output = s.tool_info?.output;
  if (s.state === "DONE" && typeof output !== "string") return [];
  return [{ type: "toolOutput", error: s.state !== "DONE", text: output ?? "" }];
}

// stream-json events (by `event`) → Deckhand's; other events give none (the deltas themselves:
// deckhand.text has them whole).
const EVENTS = {
  init: (e) => [{ type: "started", ...(e.init?.model && { model: e.init.model }) }],
  "deckhand.text": (e) => [{ type: "text", text: e.text ?? "" }],
  step_update: (e) => stepEvents(e.step_update),
  result: ({ result: r = {} }) => [
    {
      type: "result",
      ok: r.status === "SUCCESS",
      text: (r.status === "SUCCESS" ? r.response : r.error || r.response) ?? "",
      durationMs: Math.round((r.duration_seconds ?? 0) * 1000),
    },
  ],
};

// Claude Code's aliases and Codex's models mean nothing to `agy`, nor do a gateway's names
// (anthropic/…); the plan's own Claude and GPT-OSS models pass.
const FOREIGN = /^(opus|sonnet|haiku)(\[.*\])?$|\[|\/|^gpt-(?!oss)|^o\d/i;

export const antigravity = {
  name: "antigravity",
  displayName: "Antigravity CLI",
  install: (config) =>
    installSpec("antigravity", {
      volume: config.agyVolume,
      version: config.agyVersion,
      versionVar: "AGY_VERSION",
      // What the tarball must be (release-install): none, and it isn't installed.
      env: { AGY_SHA256: config.agySha256 ?? "" },
      // GitHub's releases, which redirect to their storage.
      hosts: ["github.com", "*.githubusercontent.com"],
    }),
  // With a Gemini API key, `agy` calls the listener's /google endpoint directly; with a plan's
  // login, the sandbox writes its token file with the run's agent token instead
  // (antigravity.sh, DECKHAND_AGENT_TOKEN).
  env: (config, secret) =>
    config?.agyCredential === "GEMINI_API_KEY"
      ? { GEMINI_API_KEY: secret, GOOGLE_GEMINI_BASE_URL: `${config.brokerUrl}/google` }
      : { DECKHAND_AGENT_TOKEN: secret },
  secrets: GOOGLE_CREDENTIALS,
  providers: { google: { secrets: GOOGLE_CREDENTIALS } },
  defaultProvider: "google",
  hosts: [...RELAYED, "antigravity-unleash.goog", "lh3.googleusercontent.com"],
  // Decrypted by the egress proxy and handed to the listener (egress.mjs), for its runs only.
  relayed: RELAYED,
  blocked: BLOCKED,
  // ~/.gemini: its conversations, settings and token file, a volume per issue.
  session: { volume: "antigravity", path: "/home/node/.gemini" },
  // `agy -p` reads no more input once started: comments wait for the next run, which resumes
  // the conversation (tasks.mjs, deliverable()).
  takesMessages: false,
  models: (config = {}) => ({ ...MODELS, ...config.agyModels }),
  efforts: EFFORTS,
  modelProblem: (model) =>
    FOREIGN.test(model) ? `\`${model}\` is not one of the Antigravity CLI's models` : null,
  // One line of its output → Deckhand's events: started, text, tool{name, detail},
  // toolOutput{text, error}, result{ok, text, durationMs}.
  normalize: normalizer(EVENTS, "event"),
};
