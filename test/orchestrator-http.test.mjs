// The orchestrator's HTTP (listener/http.mjs), as edge passes requests on to it: a route that
// throws answers 500 and leaves it up, its error logged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { serve } from "./helpers.mjs";

test("an unexpected throw answers 500, and the orchestrator keeps serving", async (t) => {
  const logged = [];
  const ctx = {
    config: { port: 0 },
    log: (line) => logged.push(line),
    skip: () => {},
    tasks: new Map(),
  };
  const http = createHttp(ctx);
  // /status a local caller's, as edge passes it on (../edge/forward.mjs). This orchestrator has
  // no status: it throws.
  const { url } = await serve(t, (req, res) => http.handle(req, res, { local: true }));
  assert.equal((await fetch(`${url}/status`)).status, 500);
  assert.ok(logged.some((line) => line.startsWith("GET /status: TypeError")));
  // The next request still gets its answer.
  assert.equal((await fetch(`${url}/status`)).status, 500);
});
