// Every page this spec renders writes its own texts through the catalog: in a marked one
// (testCatalog.ts), nothing of the dashboard's own is left unmarked.
import { render } from "@testing-library/preact";
import { beforeAll, expect, test, vi } from "vitest";
import type { RepoList } from "./api";

vi.mock("./locales", async (original) =>
  (await import("./testCatalog")).withMarked(await original()),
);

let { Dashboard } = {} as typeof import("./App");
let { makeState } = {} as typeof import("./testUtils");
let { unmarked, useMarked } = {} as typeof import("./testCatalog");

beforeAll(async () => {
  vi.resetModules();
  ({ Dashboard } = await import("./App"));
  ({ makeState } = await import("./testUtils"));
  ({ unmarked, useMarked } = await import("./testCatalog"));
});

const repos = (): RepoList => ({
  repos: [],
  app: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  listedAt: null,
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
});

test("Preferences", () => {
  useMarked();
  history.replaceState(null, "", "#/settings/preferences");
  const { container } = render(<Dashboard state={makeState()} error={null} repos={repos()} />);
  expect(unmarked(container, ["Deckhand"])).toEqual([]);
});
