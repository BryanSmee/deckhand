// Each spec's test starts with nothing seen: api.ts keeps the backlogs for the page's life.
import { afterEach } from "vitest";
import { forgetBacklogs } from "./api";

afterEach(forgetBacklogs);
