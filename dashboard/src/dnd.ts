// What the graph page's drags carry: a backlog card, a brainstorm card, or a GitHub link
// dragged from anywhere (WorkArea.tsx, Brainstorms.tsx, Graph.tsx).

// A backlog card's payload: the issue's number (its link goes along, as text).
export const ISSUE_TYPE = "application/x-deckhand-issue";
// A brainstorm card's: its issue number. Not ISSUE_TYPE: the column doesn't take its own cards
// back, and a drop elsewhere knows it is a brainstorm.
export const BRAINSTORM_TYPE = "application/x-deckhand-brainstorm";
// A link dragged from a page, GitHub's included.
export const LINK_TYPES = ["text/uri-list", "text/plain"];

// A card's drag: `type` and its issue's number, and its link for anywhere else.
export const dragOf = (type: string, number: number, url: string) => (e: DragEvent) => {
  e.dataTransfer?.setData(type, String(number));
  e.dataTransfer?.setData("text/uri-list", url);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
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
