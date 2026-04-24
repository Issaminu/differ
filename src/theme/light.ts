import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const palette = {
  fg: "#1a1a1a",
  bg: "transparent",
  caret: "#1a1a1a",
  selection: "rgba(52,104,255,0.24)",
  lineHighlight: "rgba(0,0,0,0.03)",
  keyword: "#a626a4",
  name: "#1a1a1a",
  type: "#c18401",
  operator: "#0184bc",
  string: "#50a14f",
  number: "#986801",
  comment: "#a0a1a7",
  meta: "#0184bc",
  heading: "#383a42",
};

const lightTheme = EditorView.theme(
  {
    "&": { color: palette.fg, backgroundColor: palette.bg },
    ".cm-content": { caretColor: palette.caret },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.caret },
    "&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground":
      { backgroundColor: palette.selection },
    ".cm-activeLine": { backgroundColor: palette.lineHighlight },
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  },
  { dark: false },
);

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: palette.keyword },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: palette.name },
  { tag: [t.function(t.variableName), t.labelName], color: "#4078f2" },
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
  { tag: t.invalid, color: "#e45649" },
]);

export const lightExtensions = [lightTheme, syntaxHighlighting(lightHighlight)];
