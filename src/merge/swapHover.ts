import { swapSides } from "../state";

const SWAP_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 5h9M3 5l3-3M3 5l3 3M13 11H4M13 11l-3-3M13 11l-3 3"/>
</svg>`;

// Hover band: 5% adjacent to the separator on each side (45%–55% of #app).
// The zone is pointer-transparent; only the button captures clicks.
const ZONE_MIN = 45;
const ZONE_MAX = 55;

export function mountSwapHover(host: HTMLElement): void {
  const zone = document.createElement("div");
  zone.className = "swap-zone";
  zone.innerHTML = `
    <button class="swap-btn" type="button" title="Swap sides (⌘⇧S)" aria-label="Swap sides">
      ${SWAP_ICON}
    </button>
  `;
  host.appendChild(zone);

  const btn = zone.querySelector<HTMLButtonElement>(".swap-btn")!;
  btn.addEventListener("click", swapSides);

  // The button sits above .cm-mergeView as a sibling, so wheel events on it
  // bubble to #app (not scrollable) instead of the merge scroller. Forward
  // them manually so scroll keeps working while the cursor is on the button.
  btn.addEventListener(
    "wheel",
    (e) => {
      const scroller = host.querySelector<HTMLElement>(".cm-mergeView");
      if (!scroller) return;
      scroller.scrollTop += e.deltaY;
      scroller.scrollLeft += e.deltaX;
      e.preventDefault();
    },
    { passive: false },
  );

  host.addEventListener("mousemove", (e) => {
    const rect = host.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    zone.classList.toggle("visible", pct >= ZONE_MIN && pct <= ZONE_MAX);
  });

  host.addEventListener("mouseleave", () => {
    zone.classList.remove("visible");
  });
}
