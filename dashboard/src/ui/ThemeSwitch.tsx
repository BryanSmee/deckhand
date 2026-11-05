// System, Light or Dark: the sidebar's theme switch, the same choice as Preferences › Theme.
import { Segmented, type Segment } from "./Choice";
import { Moon, Sun, System } from "./icons";
import { t } from "../i18n";
import { type Theme, usePref } from "../prefs";

const options = (): Segment<Theme>[] => [
  { value: "system", label: t("shell.themeSystem"), icon: <System size={14} />, iconOnly: true },
  { value: "light", label: t("shell.themeLight"), icon: <Sun size={14} />, iconOnly: true },
  { value: "dark", label: t("shell.themeDark"), icon: <Moon size={14} />, iconOnly: true },
];

export function ThemeSwitch({ class: className }: { class?: string }) {
  const [theme, setTheme] = usePref("theme");
  return (
    <Segmented
      class={className}
      label={t("shell.theme")}
      options={options()}
      value={theme}
      onChange={setTheme}
    />
  );
}
