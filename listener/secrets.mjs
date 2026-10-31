// Secrets a run must never publish: the operator's Claude credential (out of the sandbox, but
// a mistake elsewhere could bring it back), the run's own tokens, which the sandbox holds, and
// the GitHub tokens it got.
// Whatever Claude writes is read by people who may be anyone on a public repo: its reply and
// its log are redacted before they are posted or stored.
import { AGENT_SECRETS } from "./agents/index.mjs";

// redact() lives on its own: the API endpoints use it, and agents/ imports them (upstream.mjs).
export { REDACTED, redact } from "../lib/redact.mjs";

// The operator's credentials as the listener holds them: the agents' (AGENT_SECRETS, from its
// environment), the ChatGPT sign-in's (`ctx.openai`, openai.mjs) and the Google AI plan's
// (`ctx.google`, google.mjs), once there is one.
export function operatorSecrets(ctx, env = process.env) {
  return [
    ...AGENT_SECRETS.map((name) => env[name]),
    ...(ctx.openai?.secrets() ?? []),
    ...(ctx.google?.secrets() ?? []),
  ];
}
