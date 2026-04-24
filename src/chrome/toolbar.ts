import { effect } from "@preact/signals-core";
import {
  historyOpen,
  manualLanguage,
  activeLanguage,
  detectedLanguage,
  themePreference,
  setThemePreference,
  swapSides,
  type ThemePreference,
} from "../state";
import { availableLanguages } from "../merge/languages";

const THEME_ICON: Record<ThemePreference, string> = {
  system: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M6 14h4M8 12v2"/></svg>`,
  light: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>`,
  dark: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21.752 15.002A9.718 9.718 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998z"/></svg>`,
};

export function mountToolbar(host: HTMLElement): void {
  host.innerHTML = `
    <button class="tb-btn" data-action="swap" title="Swap sides (⌘⇧S)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 5h9M3 5l3-3M3 5l3 3M13 11H4M13 11l-3-3M13 11l-3 3"/>
      </svg>
      Swap
    </button>
    <div class="tb-lang">
      <button class="tb-btn tb-lang-trigger" data-action="lang" aria-haspopup="menu" aria-expanded="false"></button>
      <div class="tb-menu tb-lang-menu" role="menu" hidden></div>
    </div>
    <div class="tb-spacer" data-tauri-drag-region></div>
    <div class="tb-theme">
      <button class="tb-btn tb-theme-trigger" data-action="theme" title="Theme" aria-haspopup="menu" aria-expanded="false"></button>
      <div class="tb-menu tb-theme-menu" role="menu" hidden>
        <button role="menuitemradio" data-pref="system">System</button>
        <button role="menuitemradio" data-pref="light">Light</button>
        <button role="menuitemradio" data-pref="dark">Dark</button>
      </div>
    </div>
    <button class="tb-btn" data-action="history" title="History (⌘H)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="6"/><path d="M8 4v4l2.5 2.5"/>
      </svg>
      History
    </button>
  `;

  const swapBtn = host.querySelector<HTMLButtonElement>('[data-action="swap"]')!;
  const historyBtn = host.querySelector<HTMLButtonElement>('[data-action="history"]')!;
  const langBtn = host.querySelector<HTMLButtonElement>('[data-action="lang"]')!;
  const langMenu = host.querySelector<HTMLDivElement>(".tb-lang-menu")!;
  const themeBtn = host.querySelector<HTMLButtonElement>('[data-action="theme"]')!;
  const themeMenu = host.querySelector<HTMLDivElement>(".tb-theme-menu")!;
  const themeItems = Array.from(
    themeMenu.querySelectorAll<HTMLButtonElement>("[data-pref]"),
  );

  // Populate language menu: Auto + all available languages
  const langEntries: { id: string; label: string }[] = [
    { id: "__auto__", label: "Auto" },
    ...availableLanguages(),
  ];
  for (const entry of langEntries) {
    const item = document.createElement("button");
    item.setAttribute("role", "menuitemradio");
    item.dataset.lang = entry.id;
    item.textContent = entry.label;
    langMenu.appendChild(item);
  }
  const langItems = Array.from(
    langMenu.querySelectorAll<HTMLButtonElement>("[data-lang]"),
  );

  swapBtn.addEventListener("click", swapSides);
  historyBtn.addEventListener("click", () => {
    historyOpen.value = !historyOpen.peek();
  });

  // Language menu: trigger label + checked-state + pick handler
  langItems.forEach((item) => {
    item.addEventListener("click", () => {
      const id = item.dataset.lang;
      if (!id) return;
      manualLanguage.value = id === "__auto__" ? null : id;
      setLangMenuOpen(false);
    });
  });

  const labelFor = (id: string) => {
    if (id === "__auto__") return "Auto";
    return availableLanguages().find((l) => l.id === id)?.label ?? id;
  };

  effect(() => {
    const manual = manualLanguage.value;
    const detected = detectedLanguage.value;
    const active = activeLanguage.value;

    const selected = manual ?? "__auto__";
    // Trigger shows the active language; Auto gets a hint when detection fires.
    const triggerLabel =
      selected === "__auto__"
        ? detected && detected !== "plaintext"
          ? `Auto · ${labelFor(detected)}`
          : "Auto"
        : labelFor(selected);
    langBtn.textContent = triggerLabel;
    langBtn.dataset.active = active;

    for (const item of langItems) {
      const on = item.dataset.lang === selected;
      item.setAttribute("aria-checked", String(on));
      item.classList.toggle("active", on);
    }
  });

  // History button pressed-state
  effect(() => {
    historyBtn.classList.toggle("primary", historyOpen.value);
  });

  // Open/close helpers — both menus share a "one-open-at-a-time" pattern.
  const setThemeMenuOpen = (open: boolean) => {
    themeMenu.hidden = !open;
    themeBtn.setAttribute("aria-expanded", String(open));
    if (open) setLangMenuOpen(false);
  };
  const setLangMenuOpen = (open: boolean) => {
    langMenu.hidden = !open;
    langBtn.setAttribute("aria-expanded", String(open));
    if (open) setThemeMenuOpen(false);
  };

  themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setThemeMenuOpen(themeMenu.hidden);
  });
  langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setLangMenuOpen(langMenu.hidden);
  });

  themeItems.forEach((item) => {
    item.addEventListener("click", () => {
      const pref = item.dataset.pref as ThemePreference | undefined;
      if (!pref) return;
      setThemePreference(pref);
      setThemeMenuOpen(false);
    });
  });

  document.addEventListener("click", (e) => {
    if (host.contains(e.target as Node)) return;
    if (!themeMenu.hidden) setThemeMenuOpen(false);
    if (!langMenu.hidden) setLangMenuOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!themeMenu.hidden) setThemeMenuOpen(false);
    if (!langMenu.hidden) setLangMenuOpen(false);
  });

  // Icon + checked-state sync
  effect(() => {
    const pref = themePreference.value;
    themeBtn.innerHTML = THEME_ICON[pref];
    themeBtn.title = `Theme: ${pref[0].toUpperCase() + pref.slice(1)}`;
    for (const item of themeItems) {
      const on = item.dataset.pref === pref;
      item.setAttribute("aria-checked", String(on));
      item.classList.toggle("active", on);
    }
  });
}
