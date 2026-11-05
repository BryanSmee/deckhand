// An agent's Markdown: the blocks and inline marks it renders, nothing of a reply's HTML or
// unsafe links, and a reply still streaming in rendered as it is.
import { render } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Markdown } from "./Markdown";

const html = (text: string) => render(<Markdown text={text} />).container.firstElementChild!;

test("headings, emphasis, code, nested lists, a link and a table", () => {
  const md = html(
    [
      "# Summary",
      "",
      "It **builds** and *passes*, with `npm test` and ***both*** ~~not~~.",
      "",
      "## Steps",
      "",
      "1. Install",
      "   - `npm ci`",
      "   - then _build_",
      "2. Run",
      "",
      "```sh",
      "npm test -- --watch",
      "```",
      "",
      "> Quoted **text**",
      "",
      "---",
      "",
      "See [the docs](https://example.com/docs) or <mailto:a@example.com>.",
      "",
      "| File | Lines |",
      "| :--- | ----: |",
      "| `a.ts` | 12 |",
      "| b.ts | 3 |",
    ].join("\n"),
  );
  expect(md.querySelector("h1")!.textContent).toBe("Summary");
  expect(md.querySelector("h2")!.textContent).toBe("Steps");
  const p = md.querySelector("p")!;
  expect(p.querySelector("strong")!.textContent).toBe("builds");
  expect(p.querySelector("em")!.textContent).toBe("passes");
  expect(p.querySelector("code")!.textContent).toBe("npm test");
  expect(p.querySelector("strong > em")!.textContent).toBe("both");
  expect(p.querySelector("del")!.textContent).toBe("not");
  const ol = md.querySelector("ol")!;
  expect(ol.children.length).toBe(2);
  const nested = ol.querySelector("li > ul")!;
  expect([...nested.children].map((li) => li.textContent)).toEqual(["npm ci", "then build"]);
  expect(nested.querySelector("code")!.textContent).toBe("npm ci");
  expect(nested.querySelector("em")!.textContent).toBe("build");
  const pre = md.querySelector("pre")!;
  expect(pre.textContent).toBe("npm test -- --watch");
  expect(pre.dataset.lang).toBe("sh");
  expect(md.querySelector("blockquote strong")!.textContent).toBe("text");
  expect(md.querySelector("hr")).toBeTruthy();
  const links = [...md.querySelectorAll("a")];
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["the docs", "https://example.com/docs"],
    ["mailto:a@example.com", "mailto:a@example.com"],
  ]);
  expect(links[0].getAttribute("target")).toBe("_blank");
  expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
  const table = md.querySelector("table")!;
  expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["File", "Lines"]);
  expect([...table.querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual([
    "a.ts12",
    "b.ts3",
  ]);
  expect(table.querySelector("td code")!.textContent).toBe("a.ts");
  expect((table.querySelector("th + th") as HTMLElement).style.textAlign).toBe("right");
});

test("raw HTML is text, and only http(s) and mailto links are anchors", () => {
  const text = [
    "<script>alert(1)</script>",
    "",
    '<img src=x onerror="alert(1)">',
    "",
    "[x](javascript:alert(1)) and [y](data:text/html,hi) and [z](src/app.ts)",
    "",
    "![pic](javascript:alert(1)) <javascript:alert(1)>",
  ].join("\n");
  const md = html(text);
  expect(md.querySelector("script, img, a")).toBeNull();
  expect(md.textContent).toContain("<script>alert(1)</script>");
  expect(md.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(md.textContent).toContain("[x](javascript:alert(1))");
  expect(md.textContent).toContain("[z](src/app.ts)");
});

test("a bare URL is a link, without the sentence's punctuation", () => {
  const md = html("Open https://example.com/a_(b). Then (https://example.com/c).");
  expect([...md.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "https://example.com/a_(b)",
    "https://example.com/c",
  ]);
});

test("snake_case and lone marks stay as written; escapes are their character", () => {
  const md = html("run_task_now and 2 * 3 * 4 and \\*not em\\*");
  expect(md.querySelector("em, strong")).toBeNull();
  expect(md.textContent).toBe("run_task_now and 2 * 3 * 4 and *not em*");
});

test("line breaks are kept; a loose list's items are paragraphs, a tight one's aren't", () => {
  const md = html("one\ntwo\n\n- a\n- b\n\n* c\n\n* d");
  expect(md.querySelector("p")!.querySelectorAll("br").length).toBe(1);
  const [tight, loose] = md.querySelectorAll("ul");
  expect(tight.querySelector("p")).toBeNull();
  expect(loose.querySelectorAll("li > p").length).toBe(2);
});

test("an ordered list keeps its start", () => {
  expect(html("3. c\n4. d").querySelector("ol")!.getAttribute("start")).toBe("3");
});

test("while it streams in: an unclosed fence, a half table, a dangling mark render", () => {
  let md = html("Here:\n\n```ts\nconst a = 1;\nconst b");
  expect(md.querySelector("pre")!.textContent).toBe("const a = 1;\nconst b");
  md = html("| a | b |\n| --- | --");
  expect([...md.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["a", "b"]);
  expect(md.querySelector("tbody")).toBeNull();
  md = html("| a | b |\n| --- | --- |\n| 1");
  expect([...md.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["1", ""]);
  md = html("| a | b |");
  expect(md.querySelector("table")).toBeNull();
  expect(md.textContent).toBe("| a | b |");
  md = html("It is **bold and `code and [link](https://exa");
  expect(md.textContent).toBe("It is **bold and `code and [link](https://exa");
  for (const partial of ["- ", "1.", "#", ">", "~~~", "[", "**", "`"]) {
    expect(() => html(partial)).not.toThrow();
  }
});
