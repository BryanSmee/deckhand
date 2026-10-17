// Secrets a run must never publish: the operator's Claude credential (out of the sandbox, but
// a mistake elsewhere could bring it back) and the run's own secret, which the sandbox holds.
// Whatever Claude writes is read by people who may be anyone on a public repo: its reply and
// its log are redacted before they are posted or stored.
import { AGENT_SECRETS } from "./agents/index.mjs";

export const REDACTED = "[redacted]";

// Shorter values are no credential, and would redact ordinary words.
const MIN_LENGTH = 16;

// `text` without any of `secrets`.
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= MIN_LENGTH) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

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
