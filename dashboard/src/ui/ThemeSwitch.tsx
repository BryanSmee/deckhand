// System, Light or Dark: the theme switch of the sidebar and of Preferences.
import { Segmented, type Segment } from "./Choice";
import { Moon, Sun, System } from "./icons";
import { type Theme, useTheme } from "./theme";

const OPTIONS: Segment<Theme>[] = [
  { value: "system", label: "System theme", icon: <System size={14} />, iconOnly: true },
  { value: "light", label: "Light theme", icon: <Sun size={14} />, iconOnly: true },
  { value: "dark", label: "Dark theme", icon: <Moon size={14} />, iconOnly: true },
];

export function ThemeSwitch({ class: className }: { class?: string }) {
  const [theme, setTheme] = useTheme();
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
