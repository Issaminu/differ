// Minimal editable text editor on raw gpui — the foundation for Differ's two
// editable diff panes (the chosen "our own editor" path). Owns a text buffer, a
// byte-offset cursor, and a focus handle, and handles basic key input:
// printable chars, backspace, enter, left/right, tab, and Cmd+V paste.
//
// Not yet wired into DiffView — line rendering with diff decorations, proper
// caret geometry, selection, and mouse positioning come with integration. This
// module establishes the gpui input plumbing (focus + on_key_down + clipboard).
#![allow(dead_code)]

use gpui::{
    div, prelude::*, px, rgb, Context, FocusHandle, KeyDownEvent, MouseButton, StyledText, Window,
};

pub struct Editor {
    text: String,
    /// Cursor as a byte offset into `text` (kept on a char boundary).
    cursor: usize,
    focus: FocusHandle,
}

impl Editor {
    pub fn new(text: impl Into<String>, cx: &mut Context<Self>) -> Self {
        Self { text: text.into(), cursor: 0, focus: cx.focus_handle() }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn set_text(&mut self, text: String) {
        self.cursor = self.cursor.min(text.len());
        self.text = text;
    }

    fn insert(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let prev = self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0);
        self.text.replace_range(prev..self.cursor, "");
        self.cursor = prev;
    }

    fn move_left(&mut self) {
        self.cursor = self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0);
    }

    fn move_right(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        self.cursor = self.text[self.cursor..]
            .char_indices()
            .nth(1)
            .map(|(i, _)| self.cursor + i)
            .unwrap_or(self.text.len());
    }

    fn on_key(&mut self, e: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let ks = &e.keystroke;

        // Cmd+V paste.
        if ks.modifiers.platform && ks.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                self.insert(&text);
                cx.notify();
            }
            return;
        }
        // Ignore other command/control chords for now (shortcuts come later).
        if ks.modifiers.platform || ks.modifiers.control {
            return;
        }

        match ks.key.as_str() {
            "backspace" => self.backspace(),
            "enter" => self.insert("\n"),
            "tab" => self.insert("    "),
            "space" => self.insert(" "),
            "left" => self.move_left(),
            "right" => self.move_right(),
            _ => {
                // key_char is the actual typed character (handles shift/option
                // layouts); absent for non-text keys, which we ignore.
                if let Some(ch) = ks.key_char.clone() {
                    self.insert(&ch);
                } else {
                    return;
                }
            }
        }
        cx.notify();
    }
}

impl Render for Editor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Foundation rendering: show the buffer with a stand-in caret glyph at
        // the cursor. Real caret geometry + per-line decoration rendering arrive
        // with DiffView integration.
        let mut shown = self.text.clone();
        shown.insert(self.cursor, '\u{2502}'); // │ stand-in caret

        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _ev, window, cx| {
                    this.focus.focus(window, cx);
                    cx.notify();
                }),
            )
            .size_full()
            .bg(rgb(0x1e1e1e))
            .text_color(rgb(0xe6e6e6))
            .p_2()
            .text_size(px(13.0))
            .child(StyledText::new(shown))
    }
}
