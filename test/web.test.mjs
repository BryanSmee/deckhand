import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { escape, page, same } from "../listener/html.mjs";
import {
  Refused,
  apiRoute,
  parseJson,
  readBody,
  readJsonBody,
  refuse,
  sameOrigin,
  sendJson,
} from "../listener/web.mjs";

// A server answering with `handle(req, res)`, closed after the test.
async function serve(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("html: escape, same, and a page with its own style", async (t) => {
  assert.equal(
    escape(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
  assert.ok(same("abc", "abc"));
  assert.ok(!same("abc", "abd"));
  assert.ok(!same("abc", "abcd"));
  const url = await serve(t, (req, res) =>
    page(res, 403, "<Nope>", "<p>body</p>", { headers: { "x-extra": "1" }, css: ".x { y: z; }" }),
  );
  const res = await fetch(url);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-extra"), "1");
  const html = await res.text();
  assert.match(html, /<title>&lt;Nope&gt; · Deckhand<\/title>/);
  assert.match(html, /<h1>&lt;Nope&gt;<\/h1>\s*<p>body<\/p>/);
  assert.match(html, /color-scheme: light dark[\s\S]*\.x \{ y: z; \}/);
});

test("sendJson: never cached, with its status", async (t) => {
  const url = await serve(t, (req, res) => sendJson(res, { ok: true }, 201));
  const res = await fetch(url);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true });
});

test("readBody: the body up to its limit; past it, the request is dropped", async (t) => {
  const url = await serve(t, (req, res) =>
    readBody(req, 10).then(
      (body) => res.end(`got ${body}`),
      (error) => res.end(error.message),
    ),
  );
  assert.equal(
    await (await fetch(url, { method: "POST", body: "0123456789" })).text(),
    "got 0123456789",
  );
  const big = await fetch(url, { method: "POST", body: "x".repeat(100000) }).then(
    (res) => res.text(),
    () => "dropped",
  );
  assert.match(big, /^(body over 10 bytes|dropped)$/);
});

test("parseJson and readJsonBody: JSON, else a 400; past the limit, a 413", async (t) => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson("null"), null);
  assert.throws(() => parseJson("nope"), { status: 400, message: "Not JSON." });
  assert.ok(new Refused(409, "x") instanceof Error);
  assert.throws(() => refuse(409, "Busy."), { status: 409, message: "Busy." });
  const url = await serve(t, (req, res) =>
    readJsonBody(req, 20).then(
      (body) => sendJson(res, { body }),
      (error) => sendJson(res, { status: error.status, error: error.message }),
    ),
  );
  const post = (body) => fetch(url, { method: "POST", body }).then((res) => res.json());
  assert.deepEqual(await post('{"n":3}'), { body: { n: 3 } });
  assert.deepEqual(await post("{"), { status: 400, error: "Not JSON." });
  const big = await post(JSON.stringify({ text: "x".repeat(100000) })).catch(() => "dropped");
  assert.ok(big === "dropped" || big.status === 413, JSON.stringify(big));
});

test("same origin: the public URL, or the host the browser asked for", () => {
  const req = (origin, host = "deckhand.example.com") => ({ headers: { origin, host } });
  assert.equal(
    sameOrigin(req("https://deckhand.example.com"), "https://deckhand.example.com"),
    true,
  );
  assert.equal(sameOrigin(req("http://localhost:5173", "localhost:5173"), null), true);
  assert.equal(sameOrigin(req("https://evil.example"), "https://deckhand.example.com"), false);
  assert.equal(sameOrigin(req(undefined), "https://deckhand.example.com"), false);
  assert.equal(sameOrigin(req("null"), "https://deckhand.example.com"), false);
});

test("apiRoute: methods, sign-in, ALLOWED_REPOS and Origin, in that order, then the handler", async (t) => {
  const logs = [];
  const seen = [];
  const handle = apiRoute({
    name: "Test",
    route: (pathname) => {
      if (pathname === "/api/all") return { what: "all" };
      const one = /^\/api\/r\/([\w-]+\/[\w-]+)\/(read|write|both|fail|refuse)$/.exec(pathname);
      return one && { repo: one[1], what: one[2], extra: "x" };
    },
    gets: {
      all: (req, res, user, repo) => sendJson(res, { user, repo }),
      read: (req, res, user, repo, found) => sendJson(res, { user, repo, extra: found.extra }),
      both: (req, res) => sendJson(res, { method: "GET" }),
      fail: async () => {
        throw new Error("GitHub is down");
      },
    },
    posts: {
      write: (req, res, user, repo) => (seen.push(repo), sendJson(res, { wrote: repo })),
      both: (req, res) => sendJson(res, { method: "POST" }),
      refuse: async () => refuse(409, "Not now."),
    },
    allowed: (repo) => repo !== "org/secret",
    publicUrl: () => "https://deckhand.example.com",
    log: (line) => logs.push(line),
  });
  const url = await serve(t, (req, res) => {
    const user = req.headers["x-user"] || null;
    if (!handle(req, res, user)) sendJson(res, { error: "not ours" }, 404);
  });
  const ask = async (
    method,
    path,
    { user = "alice", origin = "https://deckhand.example.com" } = {},
  ) => {
    const headers = { ...(user && { "x-user": user }), ...(origin && { origin }) };
    const res = await fetch(url + path, { method, headers });
    return [res.status, await res.json()];
  };
  assert.deepEqual(await ask("GET", "/api/other"), [404, { error: "not ours" }]);
  assert.deepEqual(await ask("GET", "/api/r/org/app/write"), [405, { error: "POST only." }]);
  assert.deepEqual(await ask("POST", "/api/r/org/app/read"), [405, { error: "GET only." }]);
  assert.deepEqual(await ask("PUT", "/api/r/org/app/both"), [405, { error: "POST or GET only." }]);
  assert.deepEqual(await ask("GET", "/api/r/org/app/read", { user: null }), [
    401,
    { error: "Sign in first." },
  ]);
  assert.deepEqual(await ask("GET", "/api/r/org/secret/read"), [
    404,
    { error: "org/secret is not in ALLOWED_REPOS." },
  ]);
  assert.deepEqual(await ask("GET", "/api/r/org/app/read", { origin: null }), [
    200,
    { user: "alice", repo: "org/app", extra: "x" },
  ]);
  assert.deepEqual(await ask("GET", "/api/all"), [200, { user: "alice", repo: null }]);
  assert.deepEqual(await ask("GET", "/api/r/org/app/both"), [200, { method: "GET" }]);
  assert.deepEqual(await ask("POST", "/api/r/org/app/both"), [200, { method: "POST" }]);
  // POSTs only from the dashboard's own page.
  for (const origin of [null, "https://evil.example"]) {
    assert.deepEqual(await ask("POST", "/api/r/org/app/write", { origin }), [
      403,
      { error: "Not from this dashboard." },
    ]);
  }
  assert.deepEqual(seen, []);
  assert.deepEqual(await ask("POST", "/api/r/org/app/write"), [200, { wrote: "org/app" }]);
  assert.deepEqual(await ask("POST", "/api/r/org/app/refuse"), [409, { error: "Not now." }]);
  assert.deepEqual(await ask("GET", "/api/r/org/app/fail"), [
    502,
    { error: "GitHub didn't answer: see the listener's logs." },
  ]);
  assert.ok(logs.some((l) => l === "Test: refused for alice: Origin https://evil.example"));
  assert.ok(logs.some((l) => l === "Test: org/app: refused for alice: Not now."));
  assert.ok(logs.some((l) => /^Test: Error: GitHub is down/.test(l)));
});
