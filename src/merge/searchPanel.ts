import { EditorView, type Panel } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import { ChevronDown, ChevronRight, ChevronUp, Replace, ReplaceAll, X } from "lucide";
import { lucideSvg } from "../chrome/lucideSvg";

const CHEVRON_RIGHT = lucideSvg(ChevronRight, { size: 14 });
const CHEVRON_DOWN = lucideSvg(ChevronDown, { size: 14 });
const CHEVRON_UP = lucideSvg(ChevronUp, { size: 14 });
const ICON_CLOSE = lucideSvg(X, { size: 14 });
const ICON_REPLACE = lucideSvg(Replace, { size: 14 });
const ICON_REPLACE_ALL = lucideSvg(ReplaceAll, { size: 14 });

export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-vs-search";
  dom.innerHTML = `
    <button class="cm-vs-chevron" data-action="toggle-replace" title="Toggle Replace" aria-expanded="false">
      ${CHEVRON_RIGHT}
    </button>
    <div class="cm-vs-rows">
      <div class="cm-vs-row">
        <div class="cm-vs-field">
          <input class="cm-vs-input" data-role="search" placeholder="Find" autocomplete="off" spellcheck="false" />
          <div class="cm-vs-options">
            <button class="cm-vs-toggle" data-toggle="case" title="Match Case" aria-pressed="false">Aa</button>
            <button class="cm-vs-toggle" data-toggle="word" title="Match Whole Word" aria-pressed="false"><span class="cm-vs-word">ab</span></button>
            <button class="cm-vs-toggle" data-toggle="regex" title="Use Regular Expression" aria-pressed="false">.*</button>
          </div>
        </div>
        <div class="cm-vs-actions">
          <button class="cm-vs-icon" data-action="prev" title="Previous Match (⇧⏎)">${CHEVRON_UP}</button>
          <button class="cm-vs-icon" data-action="next" title="Next Match (⏎)">${CHEVRON_DOWN}</button>
          <button class="cm-vs-icon" data-action="close" title="Close (Esc)">${ICON_CLOSE}</button>
        </div>
      </div>
      <div class="cm-vs-row cm-vs-replace-row" hidden>
        <div class="cm-vs-field">
          <input class="cm-vs-input" data-role="replace" placeholder="Replace" autocomplete="off" spellcheck="false" />
        </div>
        <div class="cm-vs-actions">
          <button class="cm-vs-icon" data-action="replace" title="Replace">${ICON_REPLACE}</button>
          <button class="cm-vs-icon" data-action="replace-all" title="Replace All">${ICON_REPLACE_ALL}</button>
        </div>
      </div>
    </div>
  `;

  const searchInput = dom.querySelector<HTMLInputElement>('[data-role="search"]')!;
  const replaceInput = dom.querySelector<HTMLInputElement>('[data-role="replace"]')!;
  const replaceRow = dom.querySelector<HTMLDivElement>(".cm-vs-replace-row")!;
  const chevron = dom.querySelector<HTMLButtonElement>('[data-action="toggle-replace"]')!;
  const caseBtn = dom.querySelector<HTMLButtonElement>('[data-toggle="case"]')!;
  const wordBtn = dom.querySelector<HTMLButtonElement>('[data-toggle="word"]')!;
  const regexBtn = dom.querySelector<HTMLButtonElement>('[data-toggle="regex"]')!;

  const commit = () => {
    const q = new SearchQuery({
      search: searchInput.value,
      caseSensitive: caseBtn.getAttribute("aria-pressed") === "true",
      wholeWord: wordBtn.getAttribute("aria-pressed") === "true",
      regexp: regexBtn.getAttribute("aria-pressed") === "true",
      replace: replaceInput.value,
    });
    view.dispatch({ effects: setSearchQuery.of(q) });
  };

  searchInput.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);

  for (const btn of [caseBtn, wordBtn, regexBtn]) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const pressed = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", String(!pressed));
      commit();
      searchInput.focus();
    });
  }

  const nav = (run: (v: EditorView) => boolean) => (e: Event) => {
    e.preventDefault();
    run(view);
    searchInput.focus();
  };

  dom.querySelector('[data-action="prev"]')!.addEventListener("click", nav(findPrevious));
  dom.querySelector('[data-action="next"]')!.addEventListener("click", nav(findNext));
  dom.querySelector('[data-action="replace"]')!.addEventListener("click", nav(replaceNext));
  dom.querySelector('[data-action="replace-all"]')!.addEventListener("click", nav(replaceAll));
  dom.querySelector('[data-action="close"]')!.addEventListener("click", (e) => {
    e.preventDefault();
    closeSearchPanel(view);
  });

  chevron.addEventListener("click", (e) => {
    e.preventDefault();
    const expanded = chevron.getAttribute("aria-expanded") === "true";
    const next = !expanded;
    chevron.setAttribute("aria-expanded", String(next));
    chevron.innerHTML = next ? CHEVRON_DOWN : CHEVRON_RIGHT;
    replaceRow.hidden = !next;
    searchInput.focus();
  });

  const onKeyInInput = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
    }
  };
  searchInput.addEventListener("keydown", onKeyInInput);
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceNext(view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
    }
  });

  return {
    dom,
    top: true,
    mount() {
      const q = getSearchQuery(view.state);
      searchInput.value = q.search;
      replaceInput.value = q.replace;
      caseBtn.setAttribute("aria-pressed", String(q.caseSensitive));
      wordBtn.setAttribute("aria-pressed", String(q.wholeWord));
      regexBtn.setAttribute("aria-pressed", String(q.regexp));
      // A selection from the doc becomes the initial query when opening.
      requestAnimationFrame(() => {
        searchInput.focus();
        searchInput.select();
      });
    },
  };
}
