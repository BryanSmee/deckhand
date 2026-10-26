import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { render } from "preact";
import { App } from "./App";
import { followTheme } from "./ui/theme";
import "./global.css";

followTheme();
const root = document.getElementById("app")!;

// The components' gallery, in `npm run dev` only: the build drops this branch and its chunk.
if (import.meta.env.DEV && location.hash === "#/gallery") {
  void import("./ui/Gallery").then(({ Gallery }) => render(<Gallery />, root));
} else {
  render(<App />, root);
}
