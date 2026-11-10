// Context repos at the GitHub gateway (#930): a run reads the other repositories its config names
// (context-repos.mjs) through git alone, each with a token for that repository only. The
// orchestrator decides at the run's start which it reads (context-access.mjs) and tells the
// github service with the run (`context`: github/runs.mjs runFields()), so the gateway
// (github-gateway.mjs) never reads the config:
//
// - a git fetch of a context repo the run reads goes on with a token minted for that repository
//   alone, `contents: read`, from its own installation (another owner's, maybe), or without any
//   token when the App isn't installed there (a public repository: the run's start refused a
//   private one);
// - anything else that names it is refused: its REST API, its pages and raw files, GraphQL's
//   `repository(owner:, name:)`;
// - a fetch of a repository the run could have read but doesn't (`fenced`: those its config asks
//   for without `read:context`, and the operator's `context_repos` patterns) is refused too.
//   Other repositories are as before: their calls go with the run's own token, which reads
//   public repositories only.
//
// The git gateway (git-gateway.mjs) pushes to the run's own repository alone: a context repo's
// push is refused there, as any other repository's.
import { patternMatches } from "./context-repos.mjs";

// What a context repo's token gets (github-app.mjs token(): with its metadata).
export const CONTEXT_READ = { contents: "read" };

const NAME = /^[^/\s]+\/[^/\s]+$/;
const names = (list) =>
  Array.isArray(list)
    ? list.filter((s) => typeof s === "string" && NAME.test(s)).map((s) => s.toLowerCase())
    : [];

// What the orchestrator says of a run's context repos (context-access.mjs contextOf()), checked:
// { repos: [{ repo, installed }], fenced: [names and patterns] }, empty for a run without.
export function contextFields(value) {
  const repos = Array.isArray(value?.repos)
    ? value.repos
        .filter((r) => typeof r?.repo === "string" && NAME.test(r.repo))
        .map((r) => ({ repo: r.repo.toLowerCase(), installed: r.installed === true }))
    : [];
  return { repos, fenced: names(value?.fenced) };
}

// The repository a call names (owner/name, lower case), or null: REST's `repos/<owner>/<name>/…`,
// a file host's `<prefix><owner>/<name>/…` (github-gateway.mjs FILES), the web host's
// `<owner>/<name>[.git]/…`. `where`: the gateway's route().
export function namedRepo({ api, file, path }) {
  if (file?.passthrough) return null;
  let rest = path;
  if (file) {
    if (!rest.toLowerCase().startsWith(file.prefix)) return null;
    rest = rest.slice(file.prefix.length);
  } else if (api) {
    const match = /^repos\/([^/]+\/[^/]+?)(?:\/|$)/i.exec(rest);
    return match ? match[1].toLowerCase() : null;
  }
  const match = /^([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(rest);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

// A call of `run` that names a repository of its context → null when it doesn't (the gateway's
// other checks decide), { fetch: { repo, installed } } for git's fetch of a context repo it
// reads, else { refused: { status, message } }. `fetching`: the gateway's GIT_FETCH match, for
// git's fetch.
export function contextCall(run, where, fetching) {
  const repo = fetching ? fetching[1].toLowerCase() : namedRepo(where);
  if (!repo || repo === run.repo) return null;
  const { repos = [], fenced = [] } = run.context ?? {};
  const given = repos.find((r) => r.repo === repo);
  if (given && fetching) return { fetch: given };
  if (given) {
    const what = where.api ? "its API" : where.file ? "its raw files" : "its pages";
    return {
      refused: {
        status: 403,
        message: `${repo} is one of this run's context repos: it reads it through git alone (its clone under /context), not ${what}`,
      },
    };
  }
  if (fetching && fenced.some((pattern) => patternMatches(pattern, repo))) {
    return {
      refused: {
        status: 403,
        message: `${repo} isn't a context repo this run reads: only those its .deckhand.yaml names (\`context_repos\`), the operator's grant lists and the policies give it (\`read:context\`)`,
      },
    };
  }
  return null;
}

// The token a call of `run` goes on with: its own repository's with `permissions`, or for a
// context repo's fetch (`context`: contextCall()'s), one for that repository alone, reading its
// contents, or none where the App isn't installed (a public repository). `github`: the App
// (github-app.mjs).
export async function tokenFor(github, run, permissions, context = null) {
  if (!context) return github.repoToken(run.repo, permissions);
  return context.installed ? github.repoToken(context.repo, CONTEXT_READ) : { token: null };
}

// A GraphQL call (github-graphql.mjs operationOf()'s `doc`, `op`, coerced `variables`) naming one
// of the run's context repos with `repository(owner:, name:)` among its root fields, through
// fragments too → { status, message }, or null. A repository reached otherwise (`node`, a search)
// is GitHub's to answer with the run's own token, which reads public repositories only.
export function contextGraphql(run, { doc, op, variables = {} }) {
  const repos = run.context?.repos ?? [];
  if (!repos.length) return null;
  const fragments = new Map(
    doc.definitions.filter((d) => d.kind === "FragmentDefinition").map((d) => [d.name.value, d]),
  );
  const value = (node) => (node?.kind === "Variable" ? variables?.[node.name.value] : node?.value);
  const arg = (field, name) => value(field.arguments?.find((a) => a.name.value === name)?.value);
  const seen = new Set();
  const named = [];
  const walk = (set) => {
    for (const node of set?.selections ?? []) {
      if (node.kind === "Field" && node.name.value === "repository") {
        named.push(`${arg(node, "owner")}/${arg(node, "name")}`.toLowerCase());
      } else if (node.kind === "InlineFragment") walk(node.selectionSet);
      else if (node.kind === "FragmentSpread" && !seen.has(node.name.value)) {
        seen.add(node.name.value);
        walk(fragments.get(node.name.value)?.selectionSet);
      }
    }
  };
  walk(op.selectionSet);
  const repo = named.find((name) => repos.some((r) => r.repo === name));
  return repo
    ? {
        status: 403,
        message: `${repo} is one of this run's context repos: it reads it through git alone (its clone under /context), not GraphQL`,
      }
    : null;
}
