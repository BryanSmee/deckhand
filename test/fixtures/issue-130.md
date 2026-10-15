## Problem

The graph page (#82) lays its issues out mostly left to right:

- **Issues without arrows** (most of a board) fill a grid **row by row**, left to right and then wrapping: `dashboard/src/graph.ts:267-276` (`x: (i % columns) * …`). Reading them in the board's order (most recent first) means scanning across, then down.
- **On a phone the whole graph turns**: `App.tsx:191` passes `vertical={!wide}`, and `layout()` then puts each `/after` chain top to bottom (`graph.ts:250-258`), with the arrows running downward (`graph.ts:293-296`). So what waits for what reads differently by screen width.

The maintainer wants the reverse split: issues listed **top to bottom**, while dependent issues (an `/after` chain) still read **left to right**.

## Proposal

One direction everywhere: the board's order runs down the page, the arrows run across it.

1. **Issues without arrows in one column**, top to bottom in the board's order, instead of the row-major grid. Each is a row, like the task list. Options:
   - **a. One column** (recommended): simplest, reads like a list. On a wide screen it leaves space at the right, but it matches what the request asks for.
   - b. Column-major fill (top to bottom, then the next column), with the column height set by the viewport. Uses the width but the order is harder to follow and moves as the window resizes.
2. **Groups of linked issues stay as they are on a wide screen**: each group under the previous one (already true: `top += extent + GROUP_GAP`), columns left to right, arrows across.
3. **Phones too: chains left to right**, by dropping `vertical` from `layout()`, `settle()`, `dropTarget()` and the arrow paths, and letting the graph scroll sideways when a chain is wider than the screen (`SIZES.narrow` can stay, so a 2–3 step chain still fits 390 px). This removes a code path rather than adding one.
4. **Where the two parts go**: linked groups first, then the column of the rest (today's order), or the reverse. Recommend keeping today's order.

Pieces to reuse: `layout()`'s layering (`layersOf`, `components`), `settle()` (which keeps places stable between redraws, #107: its free-cell search in the grid needs to look in one column instead of `columns`), and `dropTarget()` for the work area's drag and drop (#94): dropping "after" a node must still pick the right node in a column.

## Acceptance criteria

- [ ] Issues with no arrow are drawn in one column, top to bottom, in the board's order, at every width.
- [ ] An `/after` chain is drawn left to right with the arrows running across, on a wide screen and at 390 px; at 390 px a chain wider than the screen scrolls sideways instead of wrapping or turning.
- [ ] Groups of linked issues still go one under the other.
- [ ] Adding, starting or queuing an issue doesn't move the others (`settle()` still keeps places, #107).
- [ ] Dragging an issue onto a node (queue after it) and onto the open area (start it) still works at both widths.
- [ ] `graph.spec.ts` covers: the column of unlinked issues, a chain left to right with `width: 390`, and no `vertical` layout left (or its tests updated if option 3 is not taken).
- [ ] Screenshots of the graph page at 1440×900 and 390×844, light and dark, on the pull request.

## Open questions

1. Phones: chains left to right with sideways scrolling (recommended), or keep today's top-to-bottom chains on a phone only?
2. Unlinked issues: a single column (recommended), or column-major fill across the width?
3. Linked groups above the column of the others (today, recommended), or below?

From the ideas inbox: https://github.com/BryanSmee/deckhand/issues/15#issuecomment-6198076723
