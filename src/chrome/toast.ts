let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string, durationMs = 1600): void {
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    el?.classList.remove("show");
  }, durationMs);
}
