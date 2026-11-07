#!/usr/bin/env node
// The Secrets a Kubernetes deployment needs and the base doesn't hold (docs/kubernetes/finish.md),
// printed as manifests for `kubectl apply -f -`: nothing is written to disk.
//
//   node deploy/kubernetes/secrets.mjs keys | kubectl apply -f -
//     The broker's signing key (deckhand-broker-key), its public key named by its kid, as the
//     broker would publish it (the deckhand-service-keys ConfigMap), and the key the models
//     service seals the plans' logins with (deckhand-models-key). Once: new keys refuse the
//     running sandboxes' tokens and the sealed logins.
//
//   node deploy/kubernetes/secrets.mjs app --url https://deckhand.example.com [--name <app>]
//       [--org <organization>] [--github https://github.com] | kubectl apply -f -
//     The GitHub App, made with /setup's manifest flow from your machine (open the address it
//     prints): its key for the github service (deckhand-github), its webhook secret and OAuth
//     client for edge, with a new session key (deckhand-edge). On a cluster the services read
//     them from these Secrets, read only, so /setup stays closed.
//
// --namespace changes the services' namespace (deckhand).
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { withoutKey } from "../../edge/app.mjs";
import { convertManifest, kept } from "../../github/app.mjs";
import { keyId } from "../../lib/tokens.mjs";
import { escape } from "../../listener/html.mjs";
import { manifest } from "../../listener/setup.mjs";

const b64 = (value) => Buffer.from(value).toString("base64");

// A manifest of `kind` (Secret or ConfigMap) holding `files`, name → contents.
export function resource(kind, name, namespace, files) {
  const lines = Object.entries(files).map(([file, value]) =>
    // Quoted: a kid may start with "-", which YAML would read as a list's item.
    kind === "Secret" ? `  "${file}": ${b64(value)}` : `  "${file}": |\n${indent(value)}`,
  );
  return [
    "---",
    "apiVersion: v1",
    `kind: ${kind}`,
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    ...(kind === "Secret" ? ["type: Opaque"] : []),
    "data:",
    ...lines,
    "",
  ].join("\n");
}
const indent = (text) =>
  String(text)
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

// The broker's key pair and models.key: → { broker, publicKeys, models } manifests.
export function keys(namespace) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = createPublicKey(createPrivateKey(pem));
  const spki = publicKey.export({ type: "spki", format: "pem" });
  return [
    resource("Secret", "deckhand-broker-key", namespace, { "run-token.key": pem }),
    resource("ConfigMap", "deckhand-service-keys", namespace, {
      [`${keyId(publicKey)}.pem`]: spki,
    }),
    resource("Secret", "deckhand-models-key", namespace, {
      "models.key": `${randomBytes(32).toString("base64")}\n`,
    }),
  ].join("");
}

// The App's credentials, as the github service's convertManifest() gives them → edge's and the
// github service's Secrets, the files /setup would have written: edge's app.json without the key
// (with the public URL, edge/app.mjs), the github service's with the key and without edge's
// secrets (github/app.mjs kept()).
export function appSecrets(credentials, { publicUrl, namespace }) {
  const edge = { ...withoutKey(credentials), public_url: publicUrl };
  return [
    resource("Secret", "deckhand-edge", namespace, {
      "app.json": `${JSON.stringify(edge, null, 2)}\n`,
      "session.key": randomBytes(32),
    }),
    resource("Secret", "deckhand-github", namespace, {
      "app.json": `${JSON.stringify(kept(credentials), null, 2)}\n`,
    }),
  ].join("");
}

// /setup's flow on 127.0.0.1: a page whose button posts the manifest to GitHub, which sends
// the browser back here with the code this converts. → the Secrets' manifests.
async function app({ url, name, org, github, namespace }) {
  const publicUrl = String(url ?? "").replace(/\/$/, "");
  if (!/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(publicUrl)) {
    throw new Error("--url: where GitHub reaches edge, http(s)://host[/path]");
  }
  if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new Error("--org: an organization's login");
  const appName = name ?? `deckhand-${randomBytes(3).toString("hex")}`;
  if (appName.length > 34) throw new Error("--name: 34 characters at most");
  const githubUrl = String(github ?? "https://github.com").replace(/\/$/, "");
  const api = githubUrl === "https://github.com" ? "https://api.github.com" : `${githubUrl}/api/v3`;
  const state = randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const here = new URL(req.url, "http://127.0.0.1");
      const page = (status, body) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Deckhand</title>${body}`);
      };
      if (here.pathname === "/") {
        const target = org
          ? `${githubUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new`
          : `${githubUrl}/settings/apps/new`;
        const wanted = {
          ...manifest({ name: appName, publicUrl }),
          redirect_url: `http://127.0.0.1:${server.address().port}/callback`,
        };
        return page(
          200,
          `<p>Create the GitHub App “${escape(appName)}” for ${escape(publicUrl)}:</p>
<form method="post" action="${escape(target)}?state=${state}">
  <input type="hidden" name="manifest" value="${escape(JSON.stringify(wanted))}" />
  <button type="submit">Create it on GitHub</button>
</form>`,
        );
      }
      if (here.pathname !== "/callback") return page(404, "<p>Not here.</p>");
      const code = here.searchParams.get("code") ?? "";
      if (here.searchParams.get("state") !== state || !/^[\w-]+$/.test(code)) {
        return page(400, "<p>Not this run's answer: start again from its address.</p>");
      }
      try {
        const made = await convertManifest({ code, api });
        if (made.status) throw new Error(made.message);
        page(
          200,
          `<p>GitHub App ${escape(made.slug)} created. Install it on your repositories:
<a href="${escape(made.html_url)}/installations/new">${escape(made.html_url)}/installations/new</a></p>`,
        );
        server.close();
        resolve({ manifests: appSecrets(made, { publicUrl, namespace }), made });
      } catch (error) {
        page(502, `<p>${escape(error.message)}</p>`);
        server.close();
        reject(error);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      console.error(`Open http://127.0.0.1:${server.address().port}/ in your browser.`);
    });
  });
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      name: { type: "string" },
      org: { type: "string" },
      github: { type: "string" },
      namespace: { type: "string", default: "deckhand" },
    },
  });
  const [command] = positionals;
  if (command === "keys") return process.stdout.write(keys(values.namespace));
  if (command === "app") {
    const { manifests, made } = await app(values);
    process.stdout.write(manifests);
    console.error(`Install it: ${made.html_url}/installations/new`);
    return;
  }
  console.error(
    "Usage: secrets.mjs keys | secrets.mjs app --url <public URL> (docs/kubernetes/finish.md)",
  );
  process.exitCode = 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
