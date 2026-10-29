// The GitHub gateway's GraphQL validation, off the listener's thread (github-graphql.mjs
// createValidator()): each document's error, or null, by its id.
import { parentPort } from "node:worker_threads";
import { validationError } from "./github-graphql.mjs";

parentPort.on("message", ({ id, query }) => {
  let error;
  try {
    error = validationError(query);
  } catch (e) {
    error = `its GraphQL couldn't be validated: ${e.message}`;
  }
  parentPort.postMessage({ id, error });
});
