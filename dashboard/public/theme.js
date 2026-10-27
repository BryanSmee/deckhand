// The theme class, set before the first paint so the page never flashes the other theme.
// A classic script in <head> (the listener's CSP allows no inline one); src/ui/theme.ts does
// the same afterwards and keeps it in step with the choice and the system's scheme.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem("deckhand.theme");
  } catch (e) {
    // Storage blocked: the system's scheme.
  }
  var dark =
    choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.add(dark ? "t-dark" : "t-light");
})();
