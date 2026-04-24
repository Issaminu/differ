import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const palette = {
  fg: "#e6e6e8",
  bg: "transparent",
  caret: "#ffffff",
  selection: "rgba(91,134,255,0.28)",
  lineHighlight: "rgba(255,255,255,0.04)",
  keyword: "#c792ea",
  name: "#e6e6e8",
  type: "#ffcb6b",
  operator: "#89ddff",
  string: "#c3e88d",
  number: "#f78c6c",
  comment: "#676e95",
  meta: "#89ddff",
  heading: "#eeffff",
};

const darkTheme = EditorView.theme(
  {
    "&": { color: palette.fg, backgroundColor: palette.bg },
    ".cm-content": { caretColor: palette.caret },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.caret },
    "&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground":
      { backgroundColor: palette.selection },
    ".cm-activeLine": { backgroundColor: palette.lineHighlight },
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  },
  { dark: true },
);

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: palette.keyword },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: palette.name },
  { tag: [t.function(t.variableName), t.labelName], color: "#82aaff" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: palette.number },
  { tag: [t.definition(t.name), t.separator], color: palette.name },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: palette.type },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: palette.operator },
  { tag: [t.meta, t.comment], color: palette.comment, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: palette.meta, textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: palette.heading },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: palette.number },
  { tag: [t.processingInstruction, t.string, t.inserted], color: palette.string },
  { tag: t.invalid, color: "#ff5370" },
]);

export const darkExtensions = [darkTheme, syntaxHighlighting(darkHighlight)];
