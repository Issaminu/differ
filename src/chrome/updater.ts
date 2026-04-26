import { signal } from "@preact/signals-core";
import { check } from "@tauri-apps/plugin-updater";

const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const LAST_CHECKED_KEY = "differ:updater:lastCheckedAt";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export const updateStatus = signal<UpdateStatus>("idle");
export const updateError = signal<string | null>(null);
export const updateAvailableVersion = signal<string | null>(null);
export const lastCheckedAt = signal<number | null>(loadLastCheckedAt());

// Drives reactive "5 minutes ago" relabeling. Bumped every 30 s so callers
// that depend on it re-render without each one wiring its own timer.
export const relativeTimeTick = signal(0);
setInterval(() => {
  relativeTimeTick.value++;
}, 30_000);

function loadLastCheckedAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CHECKED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function persistLastCheckedAt(value: number): void {
  try {
    localStorage.setItem(LAST_CHECKED_KEY, String(value));
  } catch {
    /* localStorage unavailable — fine, we'll just not persist. */
  }
}

let inFlight: Promise<void> | null = null;

export function triggerUpdateCheck(): Promise<void> {
  if (import.meta.env.VITE_TARGET === "web") return Promise.resolve();
  if (inFlight) return inFlight;
  // Once a bundle is staged, the user has to relaunch to pick it up;
  // re-checking can't change anything.
  if (updateStatus.peek() === "ready") return Promise.resolve();

  inFlight = (async () => {
    updateStatus.value = "checking";
    updateError.value = null;
    try {
      const update = await check();
      const now = Date.now();
      lastCheckedAt.value = now;
      persistLastCheckedAt(now);
      if (!update) {
        updateAvailableVersion.value = null;
        updateStatus.value = "up-to-date";
        return;
      }
      updateAvailableVersion.value = update.version;
      updateStatus.value = "downloading";
      // Stage the bundle on disk only — the new version takes effect on
      // next cold start. We don't relaunch, so the user isn't yanked out
      // of mid-session work.
      await update.downloadAndInstall();
      updateStatus.value = "ready";
    } catch (err) {
      updateStatus.value = "error";
      updateError.value = err instanceof Error ? err.message : String(err);
      console.warn("updater check failed", err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let timerStarted = false;
export function startUpdateChecker(): void {
  if (timerStarted) return;
  timerStarted = true;
  setTimeout(() => {
    void triggerUpdateCheck();
    setInterval(() => void triggerUpdateCheck(), HOUR_MS);
  }, STARTUP_DELAY_MS);
}

export function humanRelativeSince(ts: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, (now - ts) / 1000);
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1 minute ago";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.round(diffSec / 3600);
  if (hr === 1) return "1 hour ago";
  if (hr < 24) return `${hr} hours ago`;
  const days = Math.round(diffSec / 86400);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}
