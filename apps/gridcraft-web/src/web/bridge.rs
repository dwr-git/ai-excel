//! `window.aiexcel`: the control channel for the page, as promises.
//!
//! The same JSON methods as the desktop control channel (`crates/ui-egui/src/control.rs`), so the
//! assistant panel next to the editor (`studio/`) drives AI-Excel with the commands the CLI and
//! the MCP server use:
//!
//! ```js
//! await aiexcel.execute("cell.set", {cell: "B2", input: "=SUM(A1:A9)"}) // a command → its result
//! await aiexcel.request("sheet.read", {range: "A1:D10"})               // a control method → its result
//! await aiexcel.commands()                                             // every command with its params doc
//! const {base64} = await aiexcel.screenshot()                          // the window as PNG (base64)
//! aiexcel.open("Отчёт.xlsx", bytes)                                     // open a workbook (Uint8Array)
//! aiexcel.wantsKeyboard()                                              // a text field has the keyboard
//! ```
//!
//! Results resolve with the method's `result`; errors reject with an `Error`. While the page sets
//! `aiexcel.takesSaves = true`, Save and Save As reach it as an `aiexcel:save` event on `window`
//! (`detail: {name, saveAs, bytes}`) instead of a download, and whether the workbook has unsaved
//! changes as `aiexcel:dirty` (`detail: {dirty}`). The AI chip by the selection and the cell
//! context menu's AI Assistant… ask for the page's AI menu with `aiexcel:ai` (`detail: {x, y}`,
//! CSS pixels from the canvas's top left).

use std::cell::RefCell;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};

use gridcraft_ui_egui::{ControlRequest, Inbox};
use serde_json::{Value, json};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::*;

/// The most requests the page may have waiting at once (a runaway script can't fill the memory).
const MAX_WAITING: usize = 256;

/// The largest workbook the page may hand over at once.
const MAX_FILE_BYTES: u32 = 512 * 1024 * 1024;

type Waiting = (Receiver<Value>, js_sys::Function, js_sys::Function);

struct Link {
    requests: Sender<ControlRequest>,
    inbox: Inbox,
    ctx: egui::Context,
}

thread_local! {
    static LINK: RefCell<Option<Link>> = const { RefCell::new(None) };
    static WAITING: RefCell<Vec<Waiting>> = const { RefCell::new(Vec::new()) };
}

/// Connect the page to the running app: where its requests go, the inbox workbooks open from,
/// and the context to wake for a frame.
pub fn connect(requests: Sender<ControlRequest>, inbox: Inbox, ctx: egui::Context) {
    LINK.with(|l| *l.borrow_mut() = Some(Link { requests, inbox, ctx }));
}

fn repaint() {
    LINK.with(|l| {
        if let Some(link) = l.borrow().as_ref() {
            link.ctx.request_repaint();
        }
    });
}

fn to_js(v: &Value) -> JsValue {
    js_sys::JSON::parse(&v.to_string()).unwrap_or(JsValue::NULL)
}

fn from_js(v: &JsValue) -> Value {
    if v.is_undefined() || v.is_null() {
        return json!({});
    }
    js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

fn error(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
}

/// Settle the promises of answered requests (after each frame, and on a timer).
pub fn poll_replies() {
    WAITING.with(|w| {
        w.borrow_mut().retain(|(rx, resolve, reject)| match rx.try_recv() {
            Ok(reply) => {
                if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                    let _ = resolve.call1(&JsValue::NULL, &to_js(reply.get("result").unwrap_or(&Value::Null)));
                } else {
                    let message = reply.get("error").and_then(Value::as_str).unwrap_or("the request failed");
                    let _ = reject.call1(&JsValue::NULL, &error(message));
                }
                false
            }
            Err(TryRecvError::Empty) => true,
            Err(TryRecvError::Disconnected) => {
                let _ = reject.call1(&JsValue::NULL, &error("request dropped"));
                false
            }
        });
    });
}

fn request(method: &str, params: Value) -> js_sys::Promise {
    let p = js_sys::Promise::new(&mut |resolve, reject| {
        if WAITING.with(|w| w.borrow().len()) >= MAX_WAITING {
            let _ = reject.call1(&JsValue::NULL, &error("too many requests waiting"));
            return;
        }
        let (req, rx) = ControlRequest::new(method, params.clone());
        let sent = LINK.with(|l| l.borrow().as_ref().map(|link| link.requests.send(req).is_ok()));
        match sent {
            Some(true) => WAITING.with(|w| w.borrow_mut().push((rx, resolve, reject))),
            Some(false) => {
                let _ = reject.call1(&JsValue::NULL, &error("AI-Excel has closed"));
            }
            None => {
                let _ = reject.call1(&JsValue::NULL, &error("AI-Excel is not running yet"));
            }
        }
    });
    repaint();
    p
}

/// The bytes of a `Uint8Array` or `ArrayBuffer`, within [`MAX_FILE_BYTES`].
fn bytes_of(v: &JsValue) -> Result<Vec<u8>, JsValue> {
    let array = if let Some(a) = v.dyn_ref::<js_sys::Uint8Array>() {
        a.clone()
    } else if v.is_instance_of::<js_sys::ArrayBuffer>() {
        js_sys::Uint8Array::new(v)
    } else {
        return Err(error("bytes must be a Uint8Array or an ArrayBuffer"));
    };
    if array.length() > MAX_FILE_BYTES {
        return Err(error("the file is too large"));
    }
    Ok(array.to_vec())
}

/// A file name the page passed: trimmed, at most 255 characters, `fallback` when empty.
fn clean_name(name: &str, fallback: &str) -> String {
    let name: String = name.trim().chars().take(255).collect();
    if name.is_empty() { fallback.to_string() } else { name }
}

/// Open a workbook the page has (from the server's files): it opens on the next frame, as one
/// picked with File › Open.
fn open(name: String, bytes: JsValue) -> Result<(), JsValue> {
    let bytes = bytes_of(&bytes)?;
    let name = clean_name(&name, "Книга.xlsx");
    LINK.with(|l| {
        let link = l.borrow();
        let link = link.as_ref().ok_or_else(|| error("AI-Excel is not running yet"))?;
        link.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
        link.ctx.request_repaint();
        Ok(())
    })
}

fn set(obj: &js_sys::Object, name: &str, f: JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &name.into(), &f).map(|_| ())
}

/// Tell the page something happened (`aiexcel:<what>` on `window`, with `detail`).
fn notify(what: &str, detail: &JsValue) -> Result<(), String> {
    let window = web_sys::window().ok_or("no window")?;
    let init = web_sys::CustomEventInit::new();
    init.set_detail(detail);
    let event = web_sys::CustomEvent::new_with_event_init_dict(&format!("aiexcel:{what}"), &init).map_err(|e| format!("{e:?}"))?;
    window.dispatch_event(&event).map(|_| ()).map_err(|e| format!("{e:?}"))
}

/// Saves go to the page while it listens (it keeps them in the user's files on the server).
pub fn save_to_page(name: &str, bytes: &[u8], save_as: bool) -> Result<bool, String> {
    if !listening() {
        return Ok(false);
    }
    let detail = js_sys::Object::new();
    let put = |k: &str, v: &JsValue| js_sys::Reflect::set(&detail, &k.into(), v).map(|_| ()).map_err(|e| format!("{e:?}"));
    put("name", &name.into())?;
    put("saveAs", &save_as.into())?;
    put("bytes", &js_sys::Uint8Array::from(bytes).into())?;
    notify("save", &detail.into())?;
    Ok(true)
}

/// Ask the page to open its AI menu at this point of the window (egui points): `aiexcel:ai` with
/// `detail: {x, y}` in CSS pixels from the canvas's top left (points times the interface zoom).
pub fn ai_menu(x: f32, y: f32) {
    let zoom = LINK.with(|l| l.borrow().as_ref().map_or(1.0, |link| link.ctx.zoom_factor()));
    let zoom = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
    let _ = notify("ai", &to_js(&json!({ "x": x * zoom, "y": y * zoom })));
}

/// Whether the page said it takes saves (`aiexcel.takesSaves = true`).
fn listening() -> bool {
    web_sys::window()
        .and_then(|w| js_sys::Reflect::get(&w, &"aiexcel".into()).ok())
        .and_then(|o| js_sys::Reflect::get(&o, &"takesSaves".into()).ok())
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Whether the workbooks have unsaved changes, told to the page when it changes.
pub fn dirty(now: bool) {
    thread_local! {
        static LAST: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
    }
    if LAST.with(|l| l.replace(Some(now))) != Some(now) {
        let _ = notify("dirty", &to_js(&json!({ "dirty": now })));
    }
}

/// Install `window.aiexcel` and the timer that settles its promises.
pub fn install() -> Result<(), JsValue> {
    let obj = js_sys::Object::new();
    set(
        &obj,
        "request",
        Closure::<dyn Fn(String, JsValue) -> js_sys::Promise>::new(|method: String, params: JsValue| request(&method, from_js(&params)))
            .into_js_value(),
    )?;
    set(
        &obj,
        "execute",
        Closure::<dyn Fn(String, JsValue) -> js_sys::Promise>::new(|command: String, params: JsValue| {
            request("engine.execute", json!({ "command": command, "params": from_js(&params) }))
        })
        .into_js_value(),
    )?;
    set(&obj, "commands", Closure::<dyn Fn() -> js_sys::Promise>::new(|| request("engine.commands", json!({}))).into_js_value())?;
    set(&obj, "inspect", Closure::<dyn Fn() -> js_sys::Promise>::new(|| request("ui.inspect", json!({}))).into_js_value())?;
    set(&obj, "screenshot", Closure::<dyn Fn() -> js_sys::Promise>::new(|| request("ui.screenshot", json!({}))).into_js_value())?;
    set(&obj, "open", Closure::<dyn Fn(String, JsValue) -> Result<(), JsValue>>::new(open).into_js_value())?;
    set(
        &obj,
        "wantsKeyboard",
        Closure::<dyn Fn() -> bool>::new(|| LINK.with(|l| l.borrow().as_ref().is_some_and(|link| link.ctx.text_edit_focused()))).into_js_value(),
    )?;
    set(&obj, "takesSaves", JsValue::FALSE)?;
    set(&obj, "product", JsValue::from_str("AI-Excel"))?;
    let w = web_sys::window().ok_or("no window")?;
    js_sys::Reflect::set(&w, &"aiexcel".into(), &obj)?;
    let tick = Closure::<dyn Fn()>::new(poll_replies).into_js_value();
    w.set_interval_with_callback_and_timeout_and_arguments_0(tick.unchecked_ref(), 40)?;
    Ok(())
}
