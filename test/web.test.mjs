import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { escape, page, same } from "../listener/html.mjs";
import { readBody, sendJson } from "../listener/web.mjs";

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
