// What the board's drags carry: a work queue card (the backlog's, a brainstorm's), or a GitHub
// link dragged from anywhere (WorkQueue.tsx, Board.tsx).

// A backlog card's payload: the issue's number (its link goes along, as text).
export const ISSUE_TYPE = "application/x-deckhand-issue";
// A brainstorm card's: its issue number. Not ISSUE_TYPE: the column doesn't take its own cards
// back, and a drop elsewhere knows it is a brainstorm.
export const BRAINSTORM_TYPE = "application/x-deckhand-brainstorm";
// A Queued card's: its task's key ("org/app#42"). On another Queued card it moves in the run
// order, on the Backlog tab it goes back to the backlog, on the graph it queues after a node
// (or moves in line, on a queued node's edges).
export const QUEUED_TYPE = "application/x-deckhand-queued";
// A link dragged from a page, GitHub's included.
export const LINK_TYPES = ["text/uri-list", "text/plain"];

// What a card's ghost on the graph shows besides its number (GraphDrawing.tsx): its state
// ("Backlog") and title.
export interface Look {
  status: string;
  title: string;
}

// The card being dragged, which a drag over can't read from the data: the board says what a
// drop would do with it ("Queue #31 after #19") and draws its ghost. Null: none of ours (a
// link, or nothing).
// `key`: a Queued card's task.
export type Carried = { type: string; number: number; key?: string } & Look;
let carried: Carried | null = null;
export const carriedCard = () => carried;

// A transparent pixel, for the browser's drag image: the board draws the card's ghost itself.
// Made ahead, as an image not yet loaded doesn't show.
const blank =
  typeof Image === "undefined"
    ? null
    : Object.assign(new Image(), {
        src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      });

// A card's drag: `type` and its issue's number, and its link for anywhere else.
export const dragOf = (type: string, number: number, url: string, look: Look) => (e: DragEvent) => {
  e.dataTransfer?.setData(type, String(number));
  e.dataTransfer?.setData("text/uri-list", url);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
  if (blank) e.dataTransfer?.setDragImage?.(blank, 0, 0);
  carried = { type, number, ...look };
};

// A Queued card's drag: the browser draws it (no ghost on the graph), the board says what a
// drop would do.
export const queuedDrag = (key: string, number: number) => (e: DragEvent) => {
  e.dataTransfer?.setData(QUEUED_TYPE, key);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  carried = { type: QUEUED_TYPE, number, key, status: "Queued", title: "" };
};

// Its end, dropped or not.
export const dragEnded = () => {
  carried = null;
};

// The issue a drop carries: a card's (`types`, the first one there), or one of `repo`'s from
// its link. Null: neither.
export function droppedIssue(
  data: DataTransfer | null,
  types: string[],
  github: string,
  repo: string | null,
): number | null {
  for (const type of types) {
    const own = Number(data?.getData(type));
    if (own) return own;
  }
  const link = data?.getData("text/uri-list") || data?.getData("text/plain") || "";
  return repo ? issueOfLink(link, github, repo) : null;
}

// The issue number a dragged GitHub link names, if it is one of `repo`'s issues (or pull
// requests): "https://github.com/org/app/issues/12", with GitHub Enterprise's own address.
export function issueOfLink(text: string, github: string, repo: string): number | null {
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url || url.startsWith("#")) continue;
    const base = `${github.replace(/\/$/, "")}/${repo}/`.toLowerCase();
    if (!url.toLowerCase().startsWith(base)) continue;
    const match = /^(?:issues|pull)\/(\d+)(?:[/?#]|$)/.exec(url.slice(base.length));
    if (match) return Number(match[1]);
  }
  return null;
}
