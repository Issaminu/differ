import { createElement, Lock, type IconNode } from "lucide";

const STROKE_ONLY_TAGS = "path, line, circle, polyline, polygon, ellipse";

/**
 * Closed padlock: solid body (rect), outline shackle (paths). Lucide's Lock mixes
 * both; setting fill on the whole SVG incorrectly fills the open shackle path.
 */
export function lucidePadlockLockedHtml(size = 14): string {
  const svg = createElement(Lock, {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
    "aria-hidden": "true",
  });
  for (const el of svg.querySelectorAll("rect")) {
    el.setAttribute("fill", "currentColor");
    el.setAttribute("stroke", "none");
  }
  for (const el of svg.querySelectorAll(STROKE_ONLY_TAGS)) {
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
  }
  return svg.outerHTML;
}

export type LucideSvgOptions = {
  size?: number;
  class?: string;
  strokeWidth?: number;
  /** Solid fill (e.g. Moon) instead of stroke outline. */
  filled?: boolean;
};

export function lucideSvg(icon: IconNode, opts: LucideSvgOptions = {}): string {
  const size = opts.size ?? 14;
  const cls = opts.class ?? "";
  const base = {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": "true" as const,
    class: cls,
  };

  if (opts.filled) {
    // Root fill only — do not set stroke="none" here: Lucide paths often rely on
    // inheriting stroke from the svg, and clearing it on the root hides the icon.
    const el = createElement(icon, {
      ...base,
      fill: "currentColor",
    });
    return el.outerHTML;
  }

  const el = createElement(icon, {
    ...base,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": opts.strokeWidth ?? 1.5,
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
  });
  return el.outerHTML;
}
