# Dashboard redesign

The dashboard (`dashboard/`) grew one view at a time, and each view styled its own buttons, tabs
and colours. This document is the design that replaces them: one set of tokens and components, a
light and a dark theme, and a layout per page. The pages to copy from are in
[`reference/`](reference/index.html): static HTML, open them in a browser.

The reference and this document describe the target. The implementation is split into issues
(see [Implementation plan](#implementation-plan)), each one shipping a working dashboard.

## What it fixes

- **The graph with the backlog is hard to read and doesn't fit a phone.** The backlog, the
  Brainstorm column and the waiting issues squeezed the graph into a third of the screen. They
  become one **work queue** panel with tabs (Backlog, Brainstorm, Waiting, Answers), the sidebar
  collapses to a rail on the board, and on a phone the graph becomes **lanes** (each chain as a
  vertical list) with the queue in a bottom sheet.
- **The all-repositories graph had a graph but no backlog.** It is gone. "All repositories" is an
  **Overview**: what waits on you across repositories, totals, and a card per repository that
  opens its board. The board exists for one repository only.
- **Buttons, tabs and navigation look different on every view.** One button (four variants,
  three sizes), one field, one segmented control, one tab bar, one chip. Repository tabs become a
  sidebar list; Tasks and Board are a toggle in the page header; Feedback and Analyze are one
  "New request".
- **No theme choice, no palette.** Cool neutrals, a near-black primary, and six status colours
  that only ever mean a state. System, Light and Dark, kept in the browser.
- **Interactions feel slow.** Every action shows its pending state at once (a dashed card,
  "Starting…"); a spinner only after 400 ms; drags show a ghost, the target and what the drop
  will do.

## Foundations

Reference: [`foundations.html`](reference/foundations.html), tokens in
[`design.css`](reference/design.css).

### Colour

Every colour is a CSS custom property; components never use a literal. The dashboard sets the
theme class on the root from the Preferences choice (System follows `prefers-color-scheme`).

| Token                        | Light               | Dark                  | Use                                     |
| ---------------------------- | ------------------- | --------------------- | --------------------------------------- |
| `--bg`                       | `#F6F7F9`           | `#0D0F14`             | The page behind panels                  |
| `--surface`                  | `#FFFFFF`           | `#151820`             | Panels, cards, inputs                   |
| `--surface-2` / `-3`         | `#F0F2F5` `#E6E9EE` | `#1C2029` `#252A35`   | Hover, selected, track                  |
| `--border` / `-strong`       | `#E1E4EA` `#C5CBD5` | `#262B36` `#3A4150`   | Dividers / control borders              |
| `--text` / `-2` / `-3`       | `#14171F` …         | `#E9ECF2` …           | Body / secondary / labels (all ≥ 4.5:1) |
| `--primary` / `--on-primary` | `#14171F` / white   | `#E9ECF2` / `#0D0F14` | The one main button of a view           |
| `--focus`                    | `#2563EB`           | `#6E9BFF`             | Focus rings, links, drop targets        |

Status tones: each has a text colour, a soft fill and a solid (dot, border).

| Tone      | Means                                      | Light text / fill / solid     | Dark text / fill / solid      |
| --------- | ------------------------------------------ | ----------------------------- | ----------------------------- |
| `s-run`   | Building image, working, stopping          | `#1D4ED8` `#E7EEFD` `#3B6FF0` | `#8FB1FF` `#16213D` `#5B86F5` |
| `s-input` | Needs you: questions, a brainstorm turn    | `#9A4A06` `#FDF0DC` `#E8890C` | `#F4B35E` `#33240E` `#E8930F` |
| `s-ready` | Its pull request is ready for review       | `#6A2DD0` `#F0EAFD` `#8B5CF6` | `#C3A6FF` `#271C44` `#9670F5` |
| `s-done`  | Done, merged, closed as completed          | `#146C34` `#E3F3E8` `#22A355` | `#6CCF8B` `#11281A` `#2DA55A` |
| `s-err`   | Error, interrupted                         | `#B42318` `#FDEBEA` `#C8322A` | `#FF8E86` `#3A1614` `#C93A31` |
| `s-idle`  | Queued, waiting for another issue, stopped | `#4B5463` `#EDEFF3` `#98A1B0` | `#AAB1BE` `#20242D` `#6B7383` |

Rules: a status colour is never alone (every badge has its word, every dot sits next to one);
running is the only thing that moves (a pulse, off with `prefers-reduced-motion`); a brainstorm
waiting for its turn is the outlined `s-input` badge. The accent orange of the old dashboard is
gone: it meant both "brand" and "needs you".

### Type and spacing

- **Inter** (400–700) for the UI, **JetBrains Mono** (400–600) for numbers, keys, branches and
  logs. Scale: 28/36 bold (page title on the Overview), 20/28 semibold (a task's title), 15/22
  semibold (section), 13.5/20 (body), 12/16 medium (meta), 12.5/20 mono (log).
- One 4 px grid. Radii: 6 (small controls), 8 (controls), 12 (cards), 16 (dialogs), pills.
- Controls: 28 (small), 36 (default), 44 on touch (phone pages use 44 everywhere).
- Fonts are served by the dashboard itself, not Google Fonts: a self-hosted listener shouldn't
  call out. The components issue settles how (a build-time `@fontsource` package, or the files
  in `dashboard/public/`); without them the stack falls back to `system-ui` and `ui-monospace`.

### Motion and feedback

| When     | What                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 0 ms     | A pressed control nudges 1 px; the action's pending state shows at once  |
| 120 ms   | Hover, focus ring, selection                                             |
| 180 ms   | Drawers, popovers, sheets slide in                                       |
| ≥ 400 ms | Only then a spinner, in the button that started it                       |
| reduced  | `prefers-reduced-motion` (or Preferences › Motion): fades only, no pulse |

## Components

Reference: [`components.html`](reference/components.html). They live in `dashboard/src/ui/`,
each a Preact component with its CSS Module, replacing `controls.module.css` and the per-view
copies. States drawn for each: default, hover, pressed, focus, disabled, pending.

- **Button**: secondary (default), primary (one per view), ghost, danger, danger-solid (the
  confirmed step of Stop); sizes small, default, touch; icon-only takes an `aria-label`.
  Pending keeps the width and says what it does ("Starting…").
- **Field**: label, input / select / textarea, help or error text; leading icon (search),
  trailing chevron (select) or key hint (`/`).
- **Checkbox, Switch** (`role="switch"`), **Segmented control** (`aria-pressed`, or links with
  `aria-current` for views), **Option card** (radio).
- **Tabs** (underlined, with counts), **Filter chip** (`aria-pressed`, with its count), **Count**
  (`.hot` when it waits on you).
- **StatusBadge**, **StatusDot**: from a task or run state through one map (`format.ts`
  `toneOf()` becomes the tone list above).
- **NavItem** (sidebar, and its icon-only rail form), **Card**, **Notice** (in a status tone),
  **Toast**, **Kbd**, **Spinner**, **Skeleton**.
- **Dialog**: head (title, context line, close), body, footer (keyboard hint left, actions
  right, main action last); focus trapped, Esc closes, Ctrl Enter sends.
- **Fold**: `details`/`summary` with a turning chevron, a status dot and a meta line; nests.
- **Icons**: inline stroke SVG at 1.8 px, in one `icons.tsx`; no icon font, no emoji.

## Layout

### App shell

- **Sidebar** (232 px, collapses to a 64 px rail, remembered): Deckhand, "New request" (a menu:
  idea, bug report, analyze runs), **Repositories** (All repositories, then each repository with
  a running dot and the count waiting on you), and at the bottom Settings (count of
  repositories that need you), run slots in use ("2 of 4 running", a meter, Sync), the theme
  switch and the user.
- **Page header**: the repository (with a GitHub link), its view toggle (Tasks | Board; Overview
  | Tasks on All repositories) and page-level controls.
- **Phone**: the sidebar is replaced by a top bar (repository switcher) and a bottom tab bar
  (Overview, Tasks, Board, Settings). Detail pages (a run log) hide the tab bar and show their
  own actions there.
- **Routes**: `#/` Overview, `#/<owner>/<repo>` Tasks, `…/board`, `…/<task>/<run>`,
  `#/settings/repositories[/<owner>/<repo>]`, `#/settings/preferences`, `#/settings/server`.
  Old addresses (`#/repositories`, the graph page) redirect.

### Pages

| Page                               | Reference                                                                                                                                                              | What changes                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks                              | [`tasks.html`](reference/tasks.html), [`mobile-tasks.html`](reference/mobile-tasks.html)                                                                               | Search, filter chips with counts, two-line rows (title, then number · mode · PR, state on the right); the task's header with its actions (GitHub, Rerun, Stop), the last reply as a card, runs as tabs.                                                                                                                       |
| Run log                            | [`run-log.html`](reference/run-log.html), [`mobile-run-log.html`](reference/mobile-run-log.html), [`mobile-run-log-search.html`](reference/mobile-run-log-search.html) | Outcome first (status, reply, pull request, facts). Foldable sections: setup, image build (its Docker steps, cached ones folded), work (messages as text, tool calls folded, failures open), push. Search with match count, filters, expand/collapse all, copy, download.                                                     |
| Board                              | [`board.html`](reference/board.html), [`mobile-board.html`](reference/mobile-board.html)                                                                               | Work queue panel (tabs) left, graph right, sidebar as a rail. Toolbar: Graph \| Lanes, Show closed, zoom, fit. Nodes: number, state, two-line title, border in their status colour when they need looking at. Drags show a ghost and "Queue #31 after #19". Pending actions as dashed nodes. Phone: lanes and a bottom sheet. |
| Overview                           | [`overview.html`](reference/overview.html)                                                                                                                             | Replaces the all-repositories graph: totals (running, waiting on you, ready, failed), "Waiting on you" across repositories with one action per row, a card per repository (status bar, counts, backlog, Open board / Onboard).                                                                                                |
| Dialogs                            | [`dialogs.html`](reference/dialogs.html)                                                                                                                               | New request (Idea \| Bug report \| Analyze runs, replacing Feedback and Analyze), open questions (option cards, "then queue it after"), Queue after… (a filterable list, for keyboard and touch), Stop (says what is lost).                                                                                                   |
| Keyboard                           | [`shortcuts.html`](reference/shortcuts.html), [`palette.html`](reference/palette.html)                                                                                 | `?` lists the shortcuts; Ctrl K jumps to a repository, task, lane or action.                                                                                                                                                                                                                                                  |
| Settings › Repositories            | [`settings.html`](reference/settings.html)                                                                                                                             | Onboarding explained in three steps while a repository isn't onboarded; the list sorted by what needs you, one action per row, flags (private, auto-merge).                                                                                                                                                                   |
| Settings › A repository's config   | [`repo-config.html`](reference/repo-config.html), [`repo-config-ok.html`](reference/repo-config-ok.html)                                                               | Errors first with their line and fix, warnings, then what its runs get with each value's source (repo, operator, refused) and a filter, hosts, mounts, the grant, the YAML with the bad lines marked. A fine config says so in a green banner and folds the rest.                                                             |
| Settings › A repository's policies | [`policy-config.html`](reference/policy-config.html)                                                                                                                   | A Policies tab next to Config: a banner when the files don't compile (every auto-merge, automatic review and fix run refuses, fail closed), a card per decision, the files merged by name (replaced operator files struck through), whether each compiles, the source with the bad line marked, and how to dry run.           |
| Task › Policies                    | [`policy-task.html`](reference/policy-task.html)                                                                                                                       | A Policies tab on a task with decisions: "Not merged automatically" when a policy denied the auto-merge, the decisions newest first with their reasons, the built-in gates that passed and the input the rules saw, the last dry run.                                                                                         |
| Settings › Preferences             | [`preferences.html`](reference/preferences.html)                                                                                                                       | Theme, density, motion, start page; notifications per event; board and log defaults; shortcuts on/off; account.                                                                                                                                                                                                               |
| Settings › Server                  | [`server.html`](reference/server.html)                                                                                                                                 | Version and uptime, run slots, engine, egress proxy, grants folder, preview hooks, the GitHub App, webhook sync, who can sign in and which repositories are allowed.                                                                                                                                                          |

### Keyboard

Shortcuts never fire while typing in a field, and Preferences can turn them off. On a Mac, Ctrl
reads ⌘.

| Where      | Keys                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everywhere | `?` shortcuts · `Ctrl K` jump to · `N` new request · `G` then `O` / `T` / `B` / `S` Overview, Tasks, Board, Settings · `\` sidebar · `Shift T` theme · `Esc` close or back      |
| Tasks      | `/` search · `J` / `K` next, previous task · `1`–`6` filters · `O` open on GitHub · `A` answer · `R` rerun · `Shift S` stop (asks) · `[` / `]` previous, next run               |
| Run log    | `F` search · `Enter` / `Shift Enter` next, previous match · `E` / `Shift E` expand, collapse all · `X` / `Shift X` next, previous error · `L` follow live · `Ctrl Shift C` copy |
| Board      | Arrows between cards · `Enter` open · `S` start · `Q` queue after… · `B` brainstorm · `V` graph or lanes · `C` show closed · `+` `−` `0` zoom, fit · Space-drag pan             |

### Responsive and accessible

- Desktop pages are fluid: the sidebar and content wrap, toolbars wrap, wide tables scroll in
  their box. Phone layouts (390 px) are their own, not a squeezed desktop.
- Real `button`, `a href`, `input` + `label` everywhere; icon-only controls have an
  `aria-label`; tabs, listboxes and dialogs use their roles; drags have a button for each
  (Start, After…, Brainstorm, Remove wait) so phones and keyboards can do the same.
- Text at 4.5:1 at least in both themes; colours that must be told apart also differ in
  lightness.

## Open items

- **Lane names** (Board, phone lanes, Ctrl K): obvious ones come from a parent issue's title
  (its sub-issues) or the inbox (ideas, bugs); the rest fall back to "#18 and 3 more" until a
  rule is decided. Tracked as its own issue, not blocking the board.
- **Density and Motion** in Preferences need a compact version of the tokens; drafted, decided
  in the Preferences issue.

## Implementation plan

Each item is an issue, a sub-issue of #299; an item starts when the ones it depends on are
merged.

| Issue | What                                                       | Depends on             |
| ----- | ---------------------------------------------------------- | ---------------------- |
| #300  | Tokens, themes and reusable components                     | this document          |
| #301  | Data: the server's setup (engine, proxy, grants, access)   |                        |
| #302  | Data: the last sync with GitHub, kept and sent             |                        |
| #303  | Data: run log phases and image build steps                 |                        |
| #304  | Data: a run's outcome facts and its last push              |                        |
| #305  | Data: backlog and lane counts per repository               |                        |
| #306  | Later: names for the board's lanes                         |                        |
| #307  | App shell, sidebar, navigation and routes                  | #300                   |
| #308  | Tasks page                                                 | #307                   |
| #309  | Run log                                                    | #308, #303, #304       |
| #310  | Board page                                                 | #307 (#306 later)      |
| #311  | Overview                                                   | #307, #305             |
| #312  | Dialogs                                                    | #307 (#304 for Stop)   |
| #313  | Keyboard shortcuts and the Ctrl K palette                  | #308, #309, #310, #312 |
| #314  | Settings › Repositories and onboarding                     | #307                   |
| #315  | Settings › a repository's config                           | #314                   |
| #316  | Settings › Preferences                                     | #314                   |
| #317  | Settings › Server                                          | #314, #301, #302       |
| #323  | Data: policy errors by file and line, replaced files, text |                        |
| #324  | Data: what a policy decision saw, and the last dry run     |                        |
| #325  | Settings › a repository's policies                         | #315, #323             |
| #326  | Task › Policies                                            | #308, #324             |
| #318  | Delete the reference pages                                 | #307–#317, #325, #326  |

The data issues (#301–#305, #323, #324) can go in parallel with #300 and the shell.

## The reference pages

[`reference/`](reference/index.html) holds a static page per artboard of the design, rendered
once with its default data, and [`design.css`](reference/design.css), the tokens and components
in one file. Interactions are drawn, not wired (folds open; tabs and drags don't). They are a
reference to copy from, not code to import: the dashboard keeps its CSS Modules. The folder is
deleted once every page ships (its own issue).
