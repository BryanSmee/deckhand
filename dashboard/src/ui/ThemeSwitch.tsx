// System, Light or Dark: the sidebar's theme switch, the same choice as Preferences › Theme.
import { Segmented, type Segment } from "./Choice";
import { Moon, Sun, System } from "./icons";
import { type Theme, usePref } from "../prefs";

const OPTIONS: Segment<Theme>[] = [
  { value: "system", label: "System theme", icon: <System size={14} />, iconOnly: true },
  { value: "light", label: "Light theme", icon: <Sun size={14} />, iconOnly: true },
  { value: "dark", label: "Dark theme", icon: <Moon size={14} />, iconOnly: true },
];

export function ThemeSwitch({ class: className }: { class?: string }) {
  const [theme, setTheme] = usePref("theme");
  return (
    <Segmented
      class={className}
      label="Theme"
      options={OPTIONS}
      value={theme}
      onChange={setTheme}
    />
  );
}
