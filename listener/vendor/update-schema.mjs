// Pins GitHub's GraphQL schema (github.graphql), which the GitHub gateway validates the runs'
// GraphQL against (../github-graphql.mjs): read from GitHub's introspection, with gh's own
// login. Run on purpose (`npm run schema`), and review its diff: a new mutation stays refused
// until github-graphql.mjs's MUTATIONS names it.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";

const query = getIntrospectionQuery({ descriptions: false, inputValueDeprecation: true });
const answer = JSON.parse(
  execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  }),
);
if (!answer.data) throw new Error(JSON.stringify(answer.errors ?? answer).slice(0, 500));
const schema = printSchema(buildClientSchema(answer.data));
writeFileSync(new URL("github.graphql", import.meta.url), `${schema}\n`);
console.log(`github.graphql: ${schema.length} bytes`);
