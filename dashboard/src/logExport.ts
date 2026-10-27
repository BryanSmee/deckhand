// A run log out of the page: copied, or downloaded as a text file. The clipboard API is there
// only on HTTPS or localhost (a Deckhand on a bare port has none): copying falls back to a
// hidden text area then, and says when neither worked.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, the page not focused): the fallback may still do.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand?.("copy") ?? false;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Not at once: some browsers would cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
