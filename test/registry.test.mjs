// The registry client the Kubernetes runner reads images with (listener/runner/registry.mjs):
// references, credentials, digests, tags and an image's config, over a fetch the tests play.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { authsOf, challenge, createRegistry, parseRef } from "../listener/runner/registry.mjs";

test("parseRef: a registry host by its dot, port or localhost, else Docker Hub's", () => {
  assert.deepEqual(parseRef("registry.example.com/dh/x:abc"), {
    host: "registry.example.com",
    name: "dh/x",
    reference: "abc",
  });
  assert.deepEqual(parseRef("localhost:5000/x"), {
    host: "localhost:5000",
    name: "x",
    reference: "latest",
  });
  assert.deepEqual(parseRef("node:26"), {
    host: "docker.io",
    name: "library/node",
    reference: "26",
  });
  assert.deepEqual(parseRef("acme/tool"), {
    host: "docker.io",
    name: "acme/tool",
    reference: "latest",
  });
  assert.deepEqual(parseRef("r.example.com:443/a/b:1@sha256:ff"), {
    host: "r.example.com:443",
    name: "a/b",
    reference: "sha256:ff",
  });
});

test("authsOf and challenge: a docker config's credentials, a registry's challenge", () => {
  assert.deepEqual(
    authsOf({
      auths: {
        "https://index.docker.io/v1/": { auth: Buffer.from("me:p:w").toString("base64") },
        "r.example.com": { username: "u", password: "p" },
        "empty.example.com": {},
      },
    }),
    {
      "docker.io": { username: "me", password: "p:w" },
      "r.example.com": { username: "u", password: "p" },
    },
  );
  assert.deepEqual(challenge('Bearer realm="https://a/token",service="a",scope="x"'), {
    scheme: "bearer",
    params: { realm: "https://a/token", service: "a", scope: "x" },
  });
  assert.equal(challenge(null), null);
});

test("registry: Basic auth, a digest hashed when HEAD doesn't say, tags by pages", async () => {
  const manifest = JSON.stringify({ config: { digest: "sha256:c" } });
  const seen = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    seen.push(
      `${init.method ?? "GET"} ${url.pathname}${url.search} ${init.headers?.authorization ?? "-"}`,
    );
    if (!init.headers?.authorization) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="r"' },
      });
    }
    if (url.pathname.endsWith("/manifests/1")) {
      return init.method === "HEAD" ? new Response(null) : new Response(manifest);
    }
    if (url.searchParams.get("last") === "b") return Response.json({ tags: ["c"] });
    return Response.json(
      { tags: ["a", "b"] },
      { headers: { link: '</v2/x/tags/list?n=2&last=b>; rel="next"' } },
    );
  };
  const registry = createRegistry({
    fetch,
    auths: async () => ({ "r.example.com": { username: "u", password: "p" } }),
  });
  assert.equal(
    await registry.digest("r.example.com/x:1"),
    `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
  );
  assert.deepEqual(await registry.tags("r.example.com/x"), ["a", "b", "c"]);
  assert.ok(seen.every((s) => s.endsWith("-") || s.endsWith(`Basic ${btoa("u:p")}`)));
  // Without credentials, a Basic challenge is a 401: nothing to answer it with.
  const anonymous = createRegistry({ fetch });
  await assert.rejects(
    anonymous.digest("r.example.com/x:1"),
    /looking up r\.example\.com\/x:1: HTTP 401/,
  );
});

test("registry: a tag list's next page as an absolute URL of the same registry, not another's", async () => {
  const seen = [];
  const fetch = async (input) => {
    const url = new URL(input);
    seen.push(url.href);
    if (url.searchParams.get("last") === "b") {
      return Response.json(
        { tags: ["c"] },
        { headers: { link: '<https://evil.example/v2/x/tags/list?last=c>; rel="next"' } },
      );
    }
    return Response.json(
      { tags: ["a", "b"] },
      { headers: { link: '<https://r.example.com/v2/x/tags/list?n=2&last=b>; rel="next"' } },
    );
  };
  const registry = createRegistry({ fetch });
  assert.deepEqual(await registry.tags("r.example.com/x"), ["a", "b", "c"]);
  assert.ok(seen.every((url) => url.startsWith("https://r.example.com/v2/x/tags/list")));
});

// The labels images.mjs checks a base's SANDBOX_API with (#980), and its build date: from its
// config, a multi-platform index's first image's.
test("registry: an image's labels and date from its config, through an index", async () => {
  const config = { created: "2026-11-01T00:00:00Z", config: { Labels: { a: "1" } } };
  const fetch = async (input) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith("/manifests/1")) {
      return Response.json(
        { manifests: [{ digest: "sha256:m" }] },
        { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
      );
    }
    if (pathname.endsWith("/manifests/sha256:m")) {
      return Response.json({ config: { digest: "sha256:c" } });
    }
    if (pathname.endsWith("/blobs/sha256:c")) return Response.json(config);
    return new Response(null, { status: 404 });
  };
  const registry = createRegistry({ fetch });
  assert.deepEqual(await registry.labels("r.example.com/x:1"), { a: "1" });
  assert.equal(await registry.created("r.example.com/x:1"), Date.parse(config.created));
  delete config.config;
  assert.deepEqual(await registry.labels("r.example.com/x:1"), {});
});
