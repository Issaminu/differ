use objc2::ClassType;
use objc2::runtime::NSObjectProtocol;
use objc2_app_kit::{NSScrollElasticity, NSScrollView, NSView};
use tauri::Manager;

pub fn disable_webview_scroll_elasticity(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if let Err(err) = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *mut NSView);
        disable_scroll_elasticity_in_tree(view);
    }) {
        eprintln!("failed to disable webview scroll elasticity: {err}");
    }
}

unsafe fn disable_scroll_elasticity_in_tree(view: &NSView) {
    if let Some(scroll_view) = view.enclosingScrollView() {
        disable_scroll_elasticity(&scroll_view);
    }

    if view.isKindOfClass(NSScrollView::class()) {
        disable_scroll_elasticity(&*(view as *const NSView as *const NSScrollView));
    }

    let subviews = view.subviews();
    for index in 0..subviews.count() {
        let subview = subviews.objectAtIndex(index);
        disable_scroll_elasticity_in_tree(&subview);
    }
}

fn disable_scroll_elasticity(scroll_view: &NSScrollView) {
    scroll_view.setVerticalScrollElasticity(NSScrollElasticity::None);
    scroll_view.setHorizontalScrollElasticity(NSScrollElasticity::None);
}
