import { effect } from "@preact/signals-core";

import pkg from "../../package.json";
import {
  getShortcutInput,
  resetAllShortcutInputs,
  resetShortcutInput,
  shortcutDefinitions,
  shortcutInputs,
  updateShortcutInput,
  type ShortcutActionId,
} from "./shortcutSettings";

// Heroicons v2 outline Cog6ToothIcon (MIT) — reads as a real gear at toolbar size.
const PREFS_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>`;

type PreferencesTab = "shortcuts" | "about";

export interface PreferencesPanelController {
  button: HTMLButtonElement;
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
}

export function mountPreferencesPanel(host: HTMLElement): PreferencesPanelController {
  host.innerHTML = `
    <div class="tb-prefs">
      <button class="tb-btn tb-icon-btn tb-prefs-trigger" data-action="preferences" title="Preferences" aria-label="Preferences" aria-haspopup="dialog" aria-expanded="false">
        ${PREFS_ICON}
      </button>
      <div class="tb-prefs-modal" hidden>
        <div class="tb-prefs-backdrop" data-action="prefs-backdrop" aria-hidden="true"></div>
        <div class="tb-prefs-panel" role="dialog" aria-modal="true" aria-labelledby="pref-dialog-title">
        <div class="pref-header">
          <div class="pref-title" id="pref-dialog-title">Preferences</div>
          <button type="button" class="tb-btn pref-close" data-action="close-preferences" aria-label="Close">✕</button>
        </div>
        <div class="pref-tabs" role="tablist" aria-label="Preferences sections">
          <button class="pref-tab active" role="tab" data-tab="shortcuts" aria-selected="true">Shortcuts</button>
          <button class="pref-tab" role="tab" data-tab="about" aria-selected="false">About</button>
        </div>
        <div class="pref-body">
          <section class="pref-view active" data-view="shortcuts">
            <div class="pref-shortcuts-toolbar">
              <div class="pref-shortcuts-copy">
                <div class="pref-label">Keyboard shortcuts</div>
                <div class="pref-help">Use <code class="pref-inline-code">Mod</code> for Command on macOS or Control elsewhere. Separate alternate bindings with commas.</div>
              </div>
              <button class="tb-btn ghost" data-action="reset-shortcuts">Reset defaults</button>
            </div>
            <div class="pref-shortcuts-list"></div>
          </section>
          <section class="pref-view" data-view="about" hidden>
            <div class="pref-about">
              <div class="pref-about-name">Differ</div>
              <div class="pref-about-version">Version ${pkg.version}</div>
              <p class="pref-about-copy">A native two-pane diff shell built for fast editing, shared history navigation, and lightweight snapshot recall.</p>
              <div class="pref-about-grid">
                <div class="pref-about-item">
                  <div class="pref-label">Runtime</div>
                  <div class="pref-help">Tauri 2</div>
                </div>
                <div class="pref-about-item">
                  <div class="pref-label">Editor</div>
                  <div class="pref-help">CodeMirror 6 merge view</div>
                </div>
                <div class="pref-about-item">
                  <div class="pref-label">History</div>
                  <div class="pref-help">Local snapshots with dedupe</div>
                </div>
              </div>
            </div>
          </section>
        </div>
        </div>
      </div>
    </div>
  `;

  const trigger = host.querySelector<HTMLButtonElement>('[data-action="preferences"]')!;
  const modal = host.querySelector<HTMLDivElement>(".tb-prefs-modal")!;
  const backdrop = host.querySelector<HTMLDivElement>('[data-action="prefs-backdrop"]')!;
  const closeBtn = host.querySelector<HTMLButtonElement>('[data-action="close-preferences"]')!;
  const tabButtons = Array.from(
    host.querySelectorAll<HTMLButtonElement>(".pref-tab"),
  );
  const views = Array.from(
    host.querySelectorAll<HTMLElement>(".pref-view"),
  );
  const resetShortcutsBtn = host.querySelector<HTMLButtonElement>('[data-action="reset-shortcuts"]')!;
  const shortcutsList = host.querySelector<HTMLDivElement>(".pref-shortcuts-list")!;

  let activeTab: PreferencesTab = "shortcuts";
  const shortcutRows = new Map<
    ShortcutActionId,
    {
      input: HTMLInputElement;
      error: HTMLDivElement;
      row: HTMLDivElement;
    }
  >();

  const setOpen = (open: boolean) => {
    const wasOpen = !modal.hidden;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", String(!open));
    trigger.setAttribute("aria-expanded", String(open));
    trigger.classList.toggle("primary", open);
    if (open) {
      requestAnimationFrame(() => tabButtons[0]?.focus());
    } else if (wasOpen) {
      trigger.focus();
    }
  };

  const setActiveTab = (tab: PreferencesTab) => {
    activeTab = tab;
    for (const button of tabButtons) {
      const on = button.dataset.tab === tab;
      button.classList.toggle("active", on);
      button.setAttribute("aria-selected", String(on));
    }
    for (const view of views) {
      const on = view.dataset.view === tab;
      view.hidden = !on;
      view.classList.toggle("active", on);
    }
  };

  const commitShortcutValue = (id: ShortcutActionId) => {
    const refs = shortcutRows.get(id);
    if (!refs) return;
    const result = updateShortcutInput(id, refs.input.value);
    if (result.ok) {
      refs.input.value = result.value;
      refs.row.classList.remove("invalid");
      refs.error.hidden = true;
      refs.error.textContent = "";
      return;
    }

    refs.row.classList.add("invalid");
    refs.error.hidden = false;
    refs.error.textContent = result.error;
  };

  const renderShortcutRows = () => {
    shortcutsList.innerHTML = "";
    shortcutRows.clear();

    const sections: Array<"Navigation" | "Search" | "Workspace"> = [
      "Navigation",
      "Search",
      "Workspace",
    ];

    for (const section of sections) {
      const group = document.createElement("div");
      group.className = "pref-shortcut-group";

      const title = document.createElement("div");
      title.className = "pref-section-title";
      title.textContent = section;
      group.appendChild(title);

      for (const item of shortcutDefinitions.filter((definition) => definition.section === section)) {
        const row = document.createElement("div");
        row.className = "pref-shortcut-row";

        const copy = document.createElement("div");
        copy.className = "pref-copy";
        copy.innerHTML = `<div class="pref-label">${item.label}</div><div class="pref-help">${item.description}</div>`;

        const controls = document.createElement("div");
        controls.className = "pref-shortcut-controls";

        const input = document.createElement("input");
        input.className = "pref-shortcut-input";
        input.type = "text";
        input.spellcheck = false;
        input.autocomplete = "off";
        input.value = getShortcutInput(item.id);

        const reset = document.createElement("button");
        reset.className = "tb-btn ghost pref-shortcut-reset";
        reset.type = "button";
        reset.textContent = "Reset";

        const error = document.createElement("div");
        error.className = "pref-shortcut-error";
        error.hidden = true;

        input.addEventListener("input", () => {
          row.classList.remove("invalid");
          error.hidden = true;
          error.textContent = "";
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitShortcutValue(item.id);
            input.blur();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            input.value = getShortcutInput(item.id);
            row.classList.remove("invalid");
            error.hidden = true;
            error.textContent = "";
            input.blur();
          }
        });
        input.addEventListener("blur", () => commitShortcutValue(item.id));

        reset.addEventListener("click", () => {
          resetShortcutInput(item.id);
          input.value = getShortcutInput(item.id);
          row.classList.remove("invalid");
          error.hidden = true;
          error.textContent = "";
        });

        controls.append(input, reset);
        row.append(copy, controls, error);
        group.appendChild(row);

        shortcutRows.set(item.id, { input, error, row });
      }

      shortcutsList.appendChild(group);
    }
  };

  renderShortcutRows();
  setActiveTab(activeTab);
  setOpen(false);

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(modal.hidden);
  });

  closeBtn.addEventListener("click", () => setOpen(false));

  backdrop.addEventListener("click", () => setOpen(false));

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab as PreferencesTab | undefined;
      if (!tab) return;
      setActiveTab(tab);
    });
  });

  resetShortcutsBtn.addEventListener("click", () => {
    resetAllShortcutInputs();
    for (const [id, refs] of shortcutRows) {
      refs.input.value = getShortcutInput(id);
      refs.row.classList.remove("invalid");
      refs.error.hidden = true;
      refs.error.textContent = "";
    }
  });

  effect(() => {
    const values = shortcutInputs.value;
    for (const [id, refs] of shortcutRows) {
      if (document.activeElement === refs.input) continue;
      refs.input.value = values[id];
      refs.row.classList.remove("invalid");
      refs.error.hidden = true;
      refs.error.textContent = "";
    }
  });

  return {
    button: trigger,
    isOpen: () => !modal.hidden,
    setOpen,
  };
}
