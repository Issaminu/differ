import { computed, signal } from "@preact/signals-core";

export type ShortcutActionId =
  | "gotoPrevChange"
  | "gotoNextChange"
  | "historyBack"
  | "historyForward"
  | "find"
  | "replace"
  | "toggleHistory"
  | "swapSides"
  | "forceCapture"
  | "clearBoth";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  section: "Navigation" | "Search" | "Workspace";
  label: string;
  description: string;
  defaultBinding: string;
}

interface ShortcutCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

type ShortcutModifierKey = "mod" | "shift" | "alt" | "ctrl" | "meta";
type ShortcutInputMap = Record<ShortcutActionId, string>;
type ShortcutComboMap = Record<ShortcutActionId, ShortcutCombo[]>;

const SHORTCUTS_KEY = "differ.shortcuts";

export function isMacLikePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Mac|iPhone|iPod|iPad/i.test(platform) || /\bMac OS X\b/i.test(ua);
}

function metaKeyDisplayToken(): string {
  if (isMacLikePlatform()) return "Cmd";
  const ua = typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
  if (/Windows/i.test(ua)) return "Win";
  return "Super";
}

/** Turn stored `Mod+…` / `Alt+…` into Cmd/Ctrl and Option/Alt for the shortcuts UI. */
export function formatShortcutForDisplay(normalized: string): string {
  const mac = isMacLikePlatform();
  return normalized
    .split(", ")
    .map((combo) =>
      combo
        .split("+")
        .map((token) => {
          if (token === "Mod") return mac ? "Cmd" : "Ctrl";
          if (token === "Alt") return mac ? "Option" : "Alt";
          if (token === "Meta") return metaKeyDisplayToken();
          return token;
        })
        .join("+"),
    )
    .join(", ");
}

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  {
    id: "gotoPrevChange",
    section: "Navigation",
    label: "Previous change",
    description: "Jump to the previous diff chunk.",
    defaultBinding: "Alt+ArrowUp",
  },
  {
    id: "gotoNextChange",
    section: "Navigation",
    label: "Next change",
    description: "Jump to the next diff chunk.",
    defaultBinding: "Alt+ArrowDown",
  },
  {
    id: "historyBack",
    section: "Navigation",
    label: "History back",
    description: "Step backward through the shared edit stack.",
    defaultBinding: "Mod+Z",
  },
  {
    id: "historyForward",
    section: "Navigation",
    label: "History forward",
    description: "Step forward through the shared edit stack.",
    defaultBinding: "Mod+Shift+Z, Mod+Y",
  },
  {
    id: "find",
    section: "Search",
    label: "Find",
    description: "Open the search panel and focus Find.",
    defaultBinding: "Mod+F",
  },
  {
    id: "replace",
    section: "Search",
    label: "Find and replace",
    description: "Open the replace row in the search panel.",
    defaultBinding: "Mod+H",
  },
  {
    id: "toggleHistory",
    section: "Workspace",
    label: "Toggle history drawer",
    description: "Open or close the saved snapshot drawer.",
    defaultBinding: "Mod+B",
  },
  {
    id: "swapSides",
    section: "Workspace",
    label: "Swap sides",
    description: "Exchange the original and modified panes.",
    defaultBinding: "Mod+Shift+S",
  },
  {
    id: "forceCapture",
    section: "Workspace",
    label: "Force history capture",
    description: "Create a snapshot immediately.",
    defaultBinding: "Mod+Shift+N",
  },
  {
    id: "clearBoth",
    section: "Workspace",
    label: "Clear both panes",
    description: "Reset both editors to empty text.",
    defaultBinding: "Mod+Shift+Backspace",
  },
] as const;

const defaultShortcutInputs = shortcutDefinitions.reduce((acc, item) => {
  acc[item.id] = item.defaultBinding;
  return acc;
}, {} as ShortcutInputMap);

function canonicalModifier(token: string): ShortcutModifierKey | null {
  const t = token.trim();
  const lower = t.toLowerCase();
  switch (lower) {
    case "mod":
      return "mod";
    case "shift":
      return "shift";
    case "alt":
    case "option":
      return "alt";
    case "ctrl":
    case "control":
      return "ctrl";
    case "cmd":
    case "command":
    case "meta":
      return "mod";
    default:
      if (t === "⌘") return "mod";
      if (t === "⌥") return "alt";
      return null;
  }
}

function canonicalKey(token: string): string | null {
  const trimmed = token.trim();
  const lower = trimmed.toLowerCase();

  switch (lower) {
    case "arrowup":
    case "up":
      return "ArrowUp";
    case "arrowdown":
    case "down":
      return "ArrowDown";
    case "arrowleft":
    case "left":
      return "ArrowLeft";
    case "arrowright":
    case "right":
      return "ArrowRight";
    case "backspace":
      return "Backspace";
    case "delete":
      return "Delete";
    case "tab":
      return "Tab";
    case "space":
      return " ";
    case "comma":
      return ",";
    default:
      break;
  }

  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (trimmed.length === 1) return trimmed.toLowerCase();
  if (/^[a-z0-9]+$/i.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

function formatKey(key: string): string {
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Backspace":
    case "Delete":
    case "Tab":
      return key;
    case " ":
      return "Space";
    case ",":
      return "Comma";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

function normalizeEventKey(key: string): string {
  switch (key) {
    case " ":
      return " ";
    case "Up":
      return "ArrowUp";
    case "Down":
      return "ArrowDown";
    case "Left":
      return "ArrowLeft";
    case "Right":
      return "ArrowRight";
    default:
      return key.length === 1 ? key.toLowerCase() : key;
  }
}

export type ShortcutCaptureResult =
  | { kind: "escape" }
  | { kind: "ignore" }
  | { kind: "binding"; normalized: string };

/**
 * Map a keydown while capturing a shortcut in preferences.
 * Escape cancels capture; modifier-only keydowns are ignored.
 */
export function shortcutBindingFromKeyboardEvent(event: KeyboardEvent): ShortcutCaptureResult {
  if (event.repeat) return { kind: "ignore" };
  if (event.key === "Escape") return { kind: "escape" };

  const modifierOnly = new Set(["Shift", "Control", "Meta", "Alt", "OS"]);
  if (modifierOnly.has(event.key)) return { kind: "ignore" };

  const key = normalizeEventKey(event.key);
  const tokens: string[] = [];
  if (event.metaKey || event.ctrlKey) tokens.push("Mod");
  if (event.shiftKey) tokens.push("Shift");
  if (event.altKey) tokens.push("Alt");
  tokens.push(formatKey(key));

  try {
    const normalized = parseShortcutInput(tokens.join("+")).normalized;
    return { kind: "binding", normalized };
  } catch {
    return { kind: "ignore" };
  }
}

function parseShortcutInput(input: string): { combos: ShortcutCombo[]; normalized: string } {
  const combos = input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (combos.length === 0) {
    throw new Error("Enter at least one shortcut.");
  }

  const parsed = combos.map((combo) => {
    const value: ShortcutCombo = {
      key: "",
      mod: false,
      shift: false,
      alt: false,
      ctrl: false,
      meta: false,
    };

    for (const rawToken of combo.split("+").map((part) => part.trim()).filter(Boolean)) {
      const modifier = canonicalModifier(rawToken);
      if (modifier) {
        value[modifier] = true;
        continue;
      }

      const key = canonicalKey(rawToken);
      if (!key) {
        throw new Error(`Unknown key "${rawToken}".`);
      }
      if (value.key) {
        throw new Error(`Only one key is allowed in "${combo}".`);
      }
      value.key = key;
    }

    if (!value.key) {
      throw new Error(`Shortcut "${combo}" is missing its key.`);
    }
    if (value.mod && (value.ctrl || value.meta)) {
      const modLabel = isMacLikePlatform() ? "Cmd" : "Ctrl";
      throw new Error(`Shortcut "${combo}" can't mix ${modLabel} with Ctrl or Meta.`);
    }

    return value;
  });

  return {
    combos: parsed,
    normalized: parsed
      .map((combo) => {
        const parts: string[] = [];
        if (combo.mod) parts.push("Mod");
        if (combo.ctrl) parts.push("Ctrl");
        if (combo.meta) parts.push("Meta");
        if (combo.alt) parts.push("Alt");
        if (combo.shift) parts.push("Shift");
        parts.push(formatKey(combo.key));
        return parts.join("+");
      })
      .join(", "),
  };
}

function loadShortcutInputs(): ShortcutInputMap {
  const raw = localStorage.getItem(SHORTCUTS_KEY);
  if (!raw) return defaultShortcutInputs;

  try {
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutActionId, unknown>>;
    const next = { ...defaultShortcutInputs };
    for (const item of shortcutDefinitions) {
      const value = parsed[item.id];
      if (typeof value !== "string") continue;
      next[item.id] = parseShortcutInput(value).normalized;
    }
    return next;
  } catch {
    return defaultShortcutInputs;
  }
}

function persistShortcutInputs(value: ShortcutInputMap): void {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(value));
}

export const shortcutInputs = signal<ShortcutInputMap>(loadShortcutInputs());

const parsedShortcutCombos = computed<ShortcutComboMap>(() => {
  const result = {} as ShortcutComboMap;
  const current = shortcutInputs.value;
  for (const item of shortcutDefinitions) {
    result[item.id] = parseShortcutInput(current[item.id]).combos;
  }
  return result;
});

export function getShortcutInput(id: ShortcutActionId): string {
  return shortcutInputs.peek()[id];
}

export function getShortcutInputDisplay(id: ShortcutActionId): string {
  return formatShortcutForDisplay(shortcutInputs.value[id]);
}

export function updateShortcutInput(
  id: ShortcutActionId,
  nextValue: string,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const parsed = parseShortcutInput(nextValue);
    const next = { ...shortcutInputs.peek(), [id]: parsed.normalized };
    shortcutInputs.value = next;
    persistShortcutInputs(next);
    return { ok: true, value: parsed.normalized };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid shortcut.",
    };
  }
}

export function resetShortcutInput(id: ShortcutActionId): void {
  const next = {
    ...shortcutInputs.peek(),
    [id]: defaultShortcutInputs[id],
  };
  shortcutInputs.value = next;
  persistShortcutInputs(next);
}

export function resetAllShortcutInputs(): void {
  shortcutInputs.value = { ...defaultShortcutInputs };
  persistShortcutInputs(shortcutInputs.peek());
}

export function matchesShortcut(event: KeyboardEvent, id: ShortcutActionId): boolean {
  const key = normalizeEventKey(event.key);

  return parsedShortcutCombos.value[id].some((combo) => {
    if (combo.key !== key) return false;
    if (combo.shift !== event.shiftKey) return false;
    if (combo.alt !== event.altKey) return false;

    if (combo.mod) {
      return (event.metaKey || event.ctrlKey) && !combo.ctrl && !combo.meta;
    }

    return combo.ctrl === event.ctrlKey && combo.meta === event.metaKey;
  });
}
