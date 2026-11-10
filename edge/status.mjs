// /status from inside edge's container, without a session (#1019): `docker compose exec edge node
// edge/status.mjs` (or `kubectl exec`). It reads the session key in DATA_DIR (/data) and calls
// edge's own port (PORT, 8080) with the token it gives (local.mjs); prints the answer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localToken } from "./local.mjs";

// Run, not imported (test/service-images.test.mjs loads every module of edge's).
if (import.meta.main) await main(process.env);

async function main(env) {
  try {
    await show(env);
  } catch (error) {
    process.stderr.write(`/status: ${error.message}\n`);
    process.exit(1);
  }
}

async function show(env) {
  const key = readFileSync(join(env.DATA_DIR || "/data", "session.key"));
  const res = await fetch(`http://127.0.0.1:${env.PORT || 8080}/status`, {
    headers: { authorization: `Bearer ${localToken(key)}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text}`.trim());
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}
