// The GitHub gateway's GraphQL validation, off the listener's thread (github-graphql.mjs
// createValidator()): each document's error, or null, by its id.
import { parentPort } from "node:worker_threads";
import { githubSchema, validationError } from "./github-graphql.mjs";

// GitHub's schema first (it takes a moment), then the documents: their time is theirs alone.
githubSchema();
parentPort.postMessage({ ready: true });

parentPort.on("message", ({ id, query }) => {
  let error;
  try {
    error = validationError(query);
  } catch (e) {
    error = `its GraphQL couldn't be validated: ${e.message}`;
  }
  parentPort.postMessage({ id, error });
});
