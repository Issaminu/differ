import { effect } from "@preact/signals-core";
import {
  historyEntries,
  historyOpen,
  originalText,
  modifiedText,
  manualLanguage,
  type HistoryEntry,
} from "../state";
import { clearHistory, deleteHistory } from "./api";

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (abs < minute) return "just now";
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diffMs / hour), "hour");
  return rtf.format(Math.round(diffMs / day), "day");
}

export function mountHistoryDrawer(host: HTMLElement): void {
  host.innerHTML = `
    <div class="hd-header">
      <div class="hd-title">History</div>
      <div style="display:flex;gap:6px;">
        <button class="tb-btn ghost" data-action="clear">Clear all</button>
        <button class="tb-btn ghost" data-action="close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="hd-list"></div>
  `;

  const list = host.querySelector<HTMLDivElement>(".hd-list")!;
  const clearBtn = host.querySelector<HTMLButtonElement>('[data-action="clear"]')!;
  const closeBtn = host.querySelector<HTMLButtonElement>('[data-action="close"]')!;

  clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear all history entries?")) return;
    try {
      const file = await clearHistory();
      historyEntries.value = file.entries;
    } catch (err) {
      console.warn("clearHistory failed", err);
    }
  });

  closeBtn.addEventListener("click", () => {
    historyOpen.value = false;
  });

  effect(() => {
    host.classList.toggle("open", historyOpen.value);
  });

  effect(() => {
    render(list, historyEntries.value);
  });
}

function render(list: HTMLDivElement, entries: HistoryEntry[]): void {
  list.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hd-empty";
    empty.textContent = "No history yet.";
    list.appendChild(empty);
    return;
  }

  const sorted = [...entries].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

  for (const entry of sorted) {
    const row = document.createElement("div");
    row.className = "hd-row";

    const preview = document.createElement("div");
    preview.className = "hd-preview";
    preview.textContent = entry.preview || "(empty)";

    const meta = document.createElement("div");
    meta.className = "hd-meta";
    const lang = entry.language && entry.language !== "plaintext" ? entry.language : "";
    meta.innerHTML = `<span>${relativeTime(entry.updatedAt)}</span>${lang ? `<span>${lang}</span>` : ""}`;

    const delBtn = document.createElement("button");
    delBtn.className = "hd-delete";
    delBtn.textContent = "✕";
    delBtn.setAttribute("aria-label", "Delete entry");
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        const file = await deleteHistory(entry.id);
        historyEntries.value = file.entries;
      } catch (err) {
        console.warn("deleteHistory failed", err);
      }
    });

    row.appendChild(preview);
    row.appendChild(meta);
    row.appendChild(delBtn);

    row.addEventListener("click", () => {
      originalText.value = entry.original;
      modifiedText.value = entry.modified;
      manualLanguage.value = entry.language;
      historyOpen.value = false;
    });

    list.appendChild(row);
  }
}
