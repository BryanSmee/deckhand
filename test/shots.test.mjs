// GET /shots/<folder>/<file>, as edge serves it (edge/shots.mjs, #609): passed on to the broker,
// which keeps the screenshots, for the names a sandbox may upload only, as images.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createShots } from "../edge/shots.mjs";
import { serve } from "./helpers.mjs";

const folder = "0123456789abcdef01234567";

// Edge's screenshots over a fake broker: `answer(path)` → { status, body } or a throw.
async function edge(t, answer) {
  const asked = [];
  const logged = [];
  const caller = {
    call: async (method, path) => {
      asked.push(`${method} ${path}`);
      return answer(path);
    },
  };
  const shots = createShots({ caller, log: (line) => logged.push(line) });
  const { url } = await serve(t, (req, res) => shots.serve(req, res));
  return { get: (path) => fetch(`${url}/shots/${path}`), asked, logged };
}

test("a screenshot from the broker, as an image of its type, cached for good", async (t) => {
  const { get, asked } = await edge(t, () => ({ status: 200, body: Buffer.from("PNG") }));
  const res = await get(`${folder}/page.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await res.text(), "PNG");
  assert.equal((await get(`${folder}/photo.jpg?v=2`)).headers.get("content-type"), "image/jpeg");
  assert.deepEqual(asked, [`GET /shots/${folder}/page.png`, `GET /shots/${folder}/photo.jpg`]);
});

test("other names are a 404 that never reaches the broker", async (t) => {
  const { get, asked } = await edge(t, () => ({ status: 200, body: Buffer.from("PNG") }));
  for (const path of [`${folder}/page.txt`, "nothex/page.png", `${folder}/a/page.png`, folder]) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.deepEqual(asked, []);
});

test("one the broker hasn't is a 404; a broker that fails or is away, not the image", async (t) => {
  const answers = {
    [`/shots/${folder}/none.png`]: () => ({ status: 404, body: Buffer.from("{}") }),
    [`/shots/${folder}/failed.png`]: () => ({ status: 500, body: Buffer.from("secret") }),
    [`/shots/${folder}/away.png`]: () => {
      throw new Error("connect ECONNREFUSED");
    },
  };
  const { get, logged } = await edge(t, (path) => answers[path]());
  assert.equal((await get(`${folder}/none.png`)).status, 404);
  const failed = await get(`${folder}/failed.png`);
  assert.equal(failed.status, 502);
  assert.equal(await failed.text(), "");
  const away = await get(`${folder}/away.png`);
  assert.deepEqual([away.status, away.headers.get("retry-after")], [503, "5"]);
  assert.deepEqual(logged, [
    "The broker: a screenshot, 500",
    "The broker: a screenshot (connect ECONNREFUSED)",
  ]);
});
