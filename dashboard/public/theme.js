// The Preferences that change the whole page (src/prefs.ts): the theme, density and motion
// classes, set before the first paint so the page never flashes the other theme. A classic
// script in <head> (the listener's CSP allows no inline one); prefs.ts does the same
// afterwards and keeps them in step with the choices and the system's settings.
(function () {
  function kept(name) {
    try {
      return localStorage.getItem("deckhand." + name);
    } catch (e) {
      // Storage blocked: the defaults.
      return null;
    }
  }
  var root = document.documentElement.classList;
  var theme = kept("theme");
  var dark =
    theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.add(dark ? "t-dark" : "t-light");
  if (kept("density") === "compact") root.add("d-compact");
  var motion = kept("motion");
  if (
    motion === "reduced" ||
    (motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  )
    root.add("m-reduced");
})();
