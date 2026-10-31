// Secrets a run must never publish: the operator's agent credentials (out of the sandbox, and
// out of the listener too, but a mistake elsewhere could bring one back), the run's own tokens,
// which the sandbox holds, and the GitHub tokens it got.
// Whatever Claude writes is read by people who may be anyone on a public repo: its reply and
// its log are redacted before they are posted or stored.
import { AGENT_SECRETS } from "./agents/index.mjs";

// redact() lives on its own (lib/redact.mjs): the models service's endpoints use it too
// (../models/upstream.mjs).
export { REDACTED, redact } from "../lib/redact.mjs";

// The operator's credentials as the listener knows them: their fingerprints, from the models
// service that holds them (`ctx.models`, models-service.mjs prints(), which lib/redact.mjs
// takes among the secrets), and any still in its own environment (a deployment from before the
// models service, #504, which shouldn't give it them).
export function operatorSecrets(ctx, env = process.env) {
  return [
    ...AGENT_SECRETS.map((name) => env[name]).filter(Boolean),
    ...(ctx.models?.prints() ?? []),
  ];
}
