import { effect } from "@preact/signals-core";
import { invoke } from "@tauri-apps/api/core";

import pkg from "../../package.json";
import { Keyboard, RotateCcw, Settings, X } from "lucide";
import { siGithub, siX } from "simple-icons";
import {
  getShortcutInputDisplay,
  resetAllShortcutInputs,
  resetShortcutInput,
  shortcutBindingFromKeyboardEvent,
  shortcutDefinitions,
  updateShortcutInput,
  type ShortcutActionId,
} from "./shortcutSettings";
import { lucideSvg } from "./lucideSvg";

const PREFS_ICON = lucideSvg(Settings, { size: 16 });
const PREF_CLOSE_ICON = lucideSvg(X, { size: 14 });
const SHORTCUT_RESET_ICON = lucideSvg(RotateCcw, { size: 14 });
const SHORTCUT_CAPTURE_ICON = lucideSvg(Keyboard, { size: 14 });

const ABOUT_GITHUB_REPO_URL = "https://github.com/Issaminu/differ";
const ABOUT_X_PROFILE_URL = "https://x.com/Issaminuu";

function simpleIconSvg(icon: { path: string }, size: number, className?: string): string {
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${icon.path}"/></svg>`;
}

const ABOUT_GITHUB_ICON = simpleIconSvg(siGithub, 18, "pref-about-link-icon");
const ABOUT_X_ICON = simpleIconSvg(siX, 18, "pref-about-link-icon");

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
          <button type="button" class="tb-btn pref-close tb-icon-btn" data-action="close-preferences" aria-label="Close">${PREF_CLOSE_ICON}</button>
        </div>
        <div class="pref-tabs" role="tablist" aria-label="Preferences sections">
          <button class="pref-tab active" role="tab" data-tab="shortcuts" aria-selected="true">Shortcuts</button>
          <button class="pref-tab" role="tab" data-tab="about" aria-selected="false">About</button>
        </div>
        <div class="pref-body">
          <section class="pref-view active" data-view="shortcuts">
            <div class="pref-shortcuts-toolbar">
              <button class="tb-btn ghost pref-reset-all-shortcuts" type="button" data-action="reset-shortcuts" title="Reset all shortcuts to defaults" aria-label="Reset all shortcuts to defaults">${SHORTCUT_RESET_ICON}<span>Reset All</span></button>
            </div>
            <div class="pref-shortcuts-list"></div>
            <p class="pref-shortcuts-footnote">Use <strong>Capture</strong> to record the next key chord, <strong>Reset</strong> for the default binding, and commas between alternate shortcuts.</p>
          </section>
          <section class="pref-view" data-view="about" hidden>
            <div class="pref-about">
              <div class="pref-about-hero">
                <div class="pref-about-hero-text">
                  <div class="pref-about-name">Differ</div>
                  <div class="pref-about-version">Version ${pkg.version}</div>
                </div>
                <img class="pref-about-app-icon" src="/app-icon.png" width="52" height="52" alt="Differ" decoding="async" />
              </div>
              <p class="pref-about-copy">A native two-pane diff shell built for fast editing, shared history navigation, and lightweight snapshot recall.</p>
              <div class="pref-about-links">
                <a class="pref-about-link" href="${ABOUT_X_PROFILE_URL}" target="_blank" rel="noopener noreferrer" aria-label="Open profile on X in your browser">
                  ${ABOUT_X_ICON}
                </a>
                <a class="pref-about-link" href="${ABOUT_GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Open repository on GitHub in your browser">
                  ${ABOUT_GITHUB_ICON}
                </a>
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

  for (const link of host.querySelectorAll<HTMLAnchorElement>(".pref-about-link")) {
    link.addEventListener(
      "click",
      (event) => {
        const url = link.getAttribute("href");
        if (!url) return;
        event.preventDefault();
        event.stopPropagation();
        void invoke("open_external_url", { url }).catch(() => {
          window.open(url, "_blank", "noopener,noreferrer");
        });
      },
      true,
    );
  }

  let activeTab: PreferencesTab = "shortcuts";
  let captureTargetId: ShortcutActionId | null = null;
  let captureButton: HTMLButtonElement | null = null;
  let captureKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  const stopShortcutCapture = () => {
    if (captureKeyHandler) {
      document.removeEventListener("keydown", captureKeyHandler, true);
      captureKeyHandler = null;
    }
    if (captureButton) {
      captureButton.classList.remove("listening");
      captureButton.setAttribute("aria-pressed", "false");
      captureButton = null;
    }
    captureTargetId = null;
  };

  const shortcutRows = new Map<
    ShortcutActionId,
    {
      input: HTMLInputElement;
      error: HTMLDivElement;
      row: HTMLDivElement;
      captureBtn: HTMLButtonElement;
    }
  >();

  const setOpen = (open: boolean) => {
    const wasOpen = !modal.hidden;
    if (!open) stopShortcutCapture();
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", String(!open));
    trigger.setAttribute("aria-expanded", String(open));
    trigger.classList.toggle("primary", open);
    document.documentElement.toggleAttribute("data-prefs-open", open);
    if (open) {
      requestAnimationFrame(() => {
        const activeBtn = tabButtons.find((b) => b.dataset.tab === activeTab);
        (activeBtn ?? tabButtons[0])?.focus();
      });
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
      button.tabIndex = on ? 0 : -1;
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
      refs.input.value = getShortcutInputDisplay(id);
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
        input.value = getShortcutInputDisplay(item.id);

        const actions = document.createElement("div");
        actions.className = "pref-shortcut-actions";

        const capture = document.createElement("button");
        capture.className = "tb-btn ghost tb-icon-btn pref-shortcut-icon-btn pref-shortcut-capture";
        capture.type = "button";
        capture.title = "Capture shortcut";
        capture.setAttribute("aria-label", "Capture shortcut");
        capture.setAttribute("aria-pressed", "false");
        capture.innerHTML = `${SHORTCUT_CAPTURE_ICON}<span class="pref-sr-only">Capture</span>`;

        const reset = document.createElement("button");
        reset.className = "tb-btn ghost tb-icon-btn pref-shortcut-icon-btn pref-shortcut-reset";
        reset.type = "button";
        reset.title = "Reset to default";
        reset.setAttribute("aria-label", "Reset to default");
        reset.innerHTML = `${SHORTCUT_RESET_ICON}<span class="pref-sr-only">Reset</span>`;

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
            input.value = getShortcutInputDisplay(item.id);
            row.classList.remove("invalid");
            error.hidden = true;
            error.textContent = "";
            input.blur();
          }
        });
        input.addEventListener("blur", () => commitShortcutValue(item.id));

        reset.addEventListener("click", () => {
          stopShortcutCapture();
          resetShortcutInput(item.id);
          input.value = getShortcutInputDisplay(item.id);
          row.classList.remove("invalid");
          error.hidden = true;
          error.textContent = "";
        });

        capture.addEventListener("click", () => {
          if (captureTargetId === item.id) {
            stopShortcutCapture();
            return;
          }
          stopShortcutCapture();
          input.blur();
          captureTargetId = item.id;
          captureButton = capture;
          capture.classList.add("listening");
          capture.setAttribute("aria-pressed", "true");
          captureKeyHandler = (event: KeyboardEvent) => {
            if (captureTargetId !== item.id) return;
            event.preventDefault();
            event.stopPropagation();
            const result = shortcutBindingFromKeyboardEvent(event);
            if (result.kind === "escape") {
              stopShortcutCapture();
              return;
            }
            if (result.kind === "ignore") return;
            const refs = shortcutRows.get(item.id);
            if (!refs) {
              stopShortcutCapture();
              return;
            }
            const commit = updateShortcutInput(item.id, result.normalized);
            if (commit.ok) {
              refs.input.value = getShortcutInputDisplay(item.id);
              refs.row.classList.remove("invalid");
              refs.error.hidden = true;
              refs.error.textContent = "";
            } else {
              refs.row.classList.add("invalid");
              refs.error.hidden = false;
              refs.error.textContent = commit.error;
            }
            stopShortcutCapture();
          };
          document.addEventListener("keydown", captureKeyHandler, true);
        });

        actions.append(capture, reset);
        controls.append(input, actions);

        const main = document.createElement("div");
        main.className = "pref-shortcut-row-main";
        main.append(copy, controls);
        row.append(main, error);
        group.appendChild(row);

        shortcutRows.set(item.id, { input, error, row, captureBtn: capture });
      }

      shortcutsList.appendChild(group);
    }
  };

  renderShortcutRows();
  setActiveTab(activeTab);
  setOpen(false);

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!!modal.hidden);
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

  const tablist = host.querySelector<HTMLDivElement>(".pref-tabs")!;
  tablist.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const focused = document.activeElement;
    const idx = tabButtons.indexOf(focused as HTMLButtonElement);
    if (idx < 0) return;
    e.preventDefault();
    const nextIdx = e.key === "ArrowRight" ? Math.min(idx + 1, tabButtons.length - 1) : Math.max(idx - 1, 0);
    const tab = tabButtons[nextIdx]?.dataset.tab as PreferencesTab | undefined;
    if (!tab) return;
    setActiveTab(tab);
    tabButtons[nextIdx]?.focus();
  });

  resetShortcutsBtn.addEventListener("click", () => {
    stopShortcutCapture();
    resetAllShortcutInputs();
    for (const [id, refs] of shortcutRows) {
      refs.input.value = getShortcutInputDisplay(id);
      refs.row.classList.remove("invalid");
      refs.error.hidden = true;
      refs.error.textContent = "";
    }
  });

  effect(() => {
    for (const [id, refs] of shortcutRows) {
      if (document.activeElement === refs.input) continue;
      refs.input.value = getShortcutInputDisplay(id);
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
