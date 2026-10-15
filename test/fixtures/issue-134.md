## Problem

The dashboard has three views (tasks, Graph, Repositories) but the header only links to two of them. The task list, which is the main view, has no link of its own:

- `dashboard/src/App.tsx:137`: the brand is a plain `<h1 class={styles.brand}>Deckhand</h1>`, so clicking it does nothing.
- `dashboard/src/App.tsx:139-160`: the `Pages` nav has only **Graph** and **Repositories**. On the graph page, the only ways back to the tasks are the browser's Back button or editing the URL. The Repositories page has its own back button (`Repos.tsx:59`), but the graph has nothing.

## Proposal

1. **A "Home" link** at the start of the `Pages` nav (`App.tsx:139`). It uses the same `styles.link` look and gets `aria-current="page"` when no `route.page` is set (the tasks view), so the active page shows the same way as Graph and Repositories.
2. **The "Deckhand" brand becomes a link** to the same place: an `<a>` inside the `<h1>`, keeping the `.brand` style (`App.module.css:16-35`: no underline, ink colour, square mark), with a visible focus ring.
3. **Where "home" goes:** the tasks view on the tab last open on this device, `formatRoute({ repo: stored("tab") || null, task: null, run: null })`. That's what a first visit (`readRoute`, `App.tsx:41-45`) and the Repositories page's back button (`App.tsx:221`) already do, so all three lead to the same place. Since these are plain `href`s, the existing `hashchange` listener handles them, and a wide screen still auto-opens the first task (`App.tsx:105-108`).
   - The alternative is to always go to `#/all`. It's simpler, but it forgets the tab the user was on. I recommend the last tab.
4. **Phones (≤ 760 px):** the brand and nav share one line (`App.module.css:114-117`). Adding a third link must not wrap the header or push "Sign out" off-screen. Check at 390 px; if it's tight, the brand link alone can serve as home there and the nav's "Home" can hide.

Reuse what's there: `formatRoute`, `stored`, `styles.link`. No API or `types.ts` change.

## Acceptance criteria

- [ ] The header nav shows **Home**, **Graph**, **Repositories**. Home is marked `aria-current="page"` on the tasks view and not on the other two pages.
- [ ] Clicking **Home** or the **Deckhand** brand from the graph, the Repositories page or a repo config opens the tasks view on the last tab used on this device (All when there is none).
- [ ] Clicking either one while a task is open on the tasks view goes back to the tab's list. On a wide screen, the first task then opens as it does today.
- [ ] The brand looks the same as today (no underline or link colour) and shows a focus ring when focused with the keyboard.
- [ ] At 390 px the header doesn't wrap or overflow, in light and dark themes.
- [ ] A test in `App.spec.tsx` covers both links' `href` and Home's `aria-current`.
- [ ] `cd dashboard && npm test && npm run build` passes, and the PR has desktop and mobile screenshots.

## Open questions

1. Should the nav link say **Home** or **Tasks**? "Tasks" says what the page shows. I'd go with **Home**, since that's the word in the request.

From the ideas inbox: https://github.com/BryanSmee/deckhand/issues/15#issuecomment-6199161052
