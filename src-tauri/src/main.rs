// Ada: ekranın tepesinde duran, Claude Code oturumlarını yöneten küçük ada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runner;
mod store;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{now, Item, Session, Settings};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

/// Pencere sabit boyutta ve şeffaf; ada CSS ile büyüyüp küçülür.
/// Adanın dışında kalan alan tıklamaları alttaki uygulamaya geçirir (bkz. hit_poller).
const WIN_W: f64 = 640.0;
const WIN_H: f64 = 520.0;
const MAX_ITEMS: usize = 400;
const SHORTCUT: &str = "ctrl+alt+space";

pub struct AppState {
    pub sessions: Mutex<Vec<Session>>,
    pub procs: Mutex<HashMap<String, u32>>,
    pub settings: Mutex<Settings>,
    /// Adanın tıklanabilir alanı, pencereye göre mantıksal piksel: x, y, w, h.
    pub hit: Mutex<[f64; 4]>,
    /// Ada açılmadan önce odakta olan pencere (Windows HWND).
    pub prev_fg: Mutex<isize>,
    pub dir: PathBuf,
}
pub type Shared = Arc<AppState>;

#[derive(Serialize, Clone)]
struct Update {
    session: Session,
    item: Option<Item>,
    /// true ise `session.items` tüm geçmişi taşır.
    full: bool,
}

pub fn emit(app: &AppHandle, s: &Session, item: Option<Item>, full: bool) {
    let session = if full { s.clone() } else { s.meta() };
    let _ = app.emit("session", Update { session, item, full });
}

/// Oturumu değiştirir, yeni satırları ekler ve arayüze bildirir.
pub fn apply(app: &AppHandle, st: &Shared, sid: &str, items: Vec<Item>, f: impl FnOnce(&mut Session)) {
    let meta = {
        let mut list = st.sessions.lock().unwrap();
        let Some(s) = list.iter_mut().find(|s| s.id == sid) else { return };
        f(s);
        s.updated = now();
        s.items.extend(items.iter().cloned());
        if s.items.len() > MAX_ITEMS {
            let n = s.items.len() - MAX_ITEMS;
            s.items.drain(..n);
        }
        s.meta()
    };
    if items.is_empty() {
        emit(app, &meta, None, false);
    } else {
        for it in items {
            emit(app, &meta, Some(it), false);
        }
    }
}

pub fn save_sessions(st: &AppState) {
    let list = st.sessions.lock().unwrap();
    store::save(&st.dir.join("sessions.json"), &*list);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    settings: Settings,
    sessions: Vec<Session>,
}

#[tauri::command]
fn get_state(st: State<'_, Shared>) -> Snapshot {
    Snapshot { settings: st.settings.lock().unwrap().clone(), sessions: st.sessions.lock().unwrap().clone() }
}

#[tauri::command]
fn send_prompt(app: AppHandle, st: State<'_, Shared>, session_id: Option<String>, prompt: String, cwd: Option<String>) -> Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Boş mesaj gönderilemez".into());
    }
    let settings = st.settings.lock().unwrap().clone();
    let (sid, cwd, resume, snapshot) = {
        let mut list = st.sessions.lock().unwrap();
        let idx = session_id.as_ref().and_then(|id| list.iter().position(|s| &s.id == id));
        let s = match idx {
            Some(i) => {
                if list[i].status == "running" {
                    return Err("Bu oturum hâlâ çalışıyor".into());
                }
                &mut list[i]
            }
            None => {
                let dir = cwd.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| settings.cwd.clone());
                if !Path::new(&dir).is_dir() {
                    return Err(format!("Klasör bulunamadı: {dir}"));
                }
                list.insert(0, Session::new(&dir, &prompt));
                &mut list[0]
            }
        };
        s.status = "running".into();
        s.activity = "Başlıyor…".into();
        s.unread = false;
        s.updated = now();
        s.items.push(Item::new("user", &prompt));
        (s.id.clone(), s.cwd.clone(), s.claude_id.clone(), s.clone())
    };
    emit(&app, &snapshot, None, true);
    runner::start(app, st.inner().clone(), sid.clone(), cwd, prompt, resume, settings);
    Ok(sid)
}

#[tauri::command]
fn cancel_session(st: State<'_, Shared>, id: String) {
    if let Some(pid) = st.procs.lock().unwrap().remove(&id) {
        runner::kill_tree(pid);
    }
}

#[tauri::command]
fn delete_session(st: State<'_, Shared>, id: String) {
    if let Some(pid) = st.procs.lock().unwrap().remove(&id) {
        runner::kill_tree(pid);
    }
    st.sessions.lock().unwrap().retain(|s| s.id != id);
    save_sessions(&st);
}

#[tauri::command]
fn mark_read(st: State<'_, Shared>, id: String) {
    if let Some(s) = st.sessions.lock().unwrap().iter_mut().find(|s| s.id == id) {
        s.unread = false;
    }
    save_sessions(&st);
}

#[tauri::command]
fn save_settings(st: State<'_, Shared>, settings: Settings) {
    store::save(&st.dir.join("settings.json"), &settings);
    *st.settings.lock().unwrap() = settings;
}

#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file().set_title("Klasör seç");
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    if let Some(s) = start.filter(|s| Path::new(s).is_dir()) {
        d = d.set_directory(s);
    }
    d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// Oturuma gerçek terminalde, etkileşimli Claude Code ile devam eder.
#[tauri::command]
fn open_terminal(st: State<'_, Shared>, id: String) -> Result<(), String> {
    let (cwd, cid) = {
        let list = st.sessions.lock().unwrap();
        let s = list.iter().find(|s| s.id == id).ok_or("Oturum yok")?;
        (s.cwd.clone(), s.claude_id.clone())
    };
    let mut args = vec!["claude".to_string()];
    if let Some(c) = cid {
        args.push("--resume".into());
        args.push(c);
    }
    if cfg!(windows) {
        if Command::new("wt").arg("-d").arg(&cwd).args(&args).spawn().is_err() {
            Command::new("cmd")
                .args(["/c", "start", "", "cmd", "/k"])
                .args(&args)
                .current_dir(&cwd)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        Err("Terminal açma şimdilik sadece Windows'ta".into())
    }
}

#[tauri::command]
fn set_hit(st: State<'_, Shared>, x: f64, y: f64, w: f64, h: f64) {
    *st.hit.lock().unwrap() = [x, y, w, h];
}

/// Ada açılınca odağı alır; önceki pencereyi hatırlar ki kapanınca odak ona dönsün.
#[tauri::command]
fn focus_window(app: AppHandle, st: State<'_, Shared>) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_focused().unwrap_or(false) {
        return;
    }
    *st.prev_fg.lock().unwrap() = fg::current();
    let _ = w.set_focus();
}

/// Esc ya da kısayolla kapanınca odağı önceki uygulamaya geri verir.
#[tauri::command]
fn release_focus(app: AppHandle, st: State<'_, Shared>) {
    let prev = std::mem::take(&mut *st.prev_fg.lock().unwrap());
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if prev != 0 && focused {
        fg::restore(prev);
    }
}

/// Win32 yardımcıları: odak ve tıklama geçirme.
#[cfg(windows)]
mod fg {
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TRANSPARENT: isize = 0x20;
    const WS_EX_LAYERED: isize = 0x80000;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    }

    /// Tauri'nin set_ignore_cursor_events(false) çağrısı WS_EX_TRANSPARENT'ı kaldırmıyor,
    /// bu yüzden bayrağı doğrudan değiştiriyoruz.
    pub fn click_through(win: &tauri::WebviewWindow, on: bool) {
        let Ok(h) = win.hwnd() else { return };
        let hwnd = h.0 as isize;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let next = if on { ex | WS_EX_TRANSPARENT | WS_EX_LAYERED } else { ex & !WS_EX_TRANSPARENT };
            if next != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
        }
    }
    pub fn current() -> isize {
        unsafe { GetForegroundWindow() }
    }
    pub fn restore(hwnd: isize) {
        unsafe {
            SetForegroundWindow(hwnd);
        }
    }
}
#[cfg(not(windows))]
mod fg {
    pub fn current() -> isize {
        0
    }
    pub fn restore(_: isize) {}
    pub fn click_through(win: &tauri::WebviewWindow, on: bool) {
        let _ = win.set_ignore_cursor_events(on);
    }
}

#[tauri::command]
fn ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        place(&w);
        let _ = w.show();
    }
}

#[tauri::command]
fn quit(app: AppHandle, st: State<'_, Shared>) {
    let pids: Vec<u32> = st.procs.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in pids {
        runner::kill_tree(p);
    }
    save_sessions(&st);
    app.exit(0);
}

/// Pencereyi ana ekranın üst ortasına yerleştirir.
fn place(win: &WebviewWindow) {
    let mon = win.primary_monitor().ok().flatten().or_else(|| win.current_monitor().ok().flatten());
    let Some(mon) = mon else { return };
    let scale = mon.scale_factor();
    let w = (WIN_W * scale).round() as i32;
    let h = (WIN_H * scale).round() as i32;
    let x = mon.position().x + (mon.size().width as i32 - w) / 2;
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(PhysicalPosition::new(x, mon.position().y));
}

/// İmleç adanın üstündeyse pencere tıklama alır, değilse tıklamalar alttaki uygulamaya geçer.
fn hit_poller(app: AppHandle, st: Shared) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let Some(win) = app.get_webview_window("main") else { continue };
            let (Ok(c), Ok(p), Ok(scale)) = (app.cursor_position(), win.outer_position(), win.scale_factor()) else {
                continue;
            };
            let [x, y, w, h] = *st.hit.lock().unwrap();
            let lx = (c.x - p.x as f64) / scale;
            let ly = (c.y - p.y as f64) / scale;
            let inside = lx >= x && lx <= x + w && ly >= y && ly <= y + h;
            if last != Some(inside) {
                fg::click_through(&win, !inside);
                last = Some(inside);
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("toggle", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let settings: Settings = store::load(&dir.join("settings.json"));
            let mut sessions: Vec<Session> = store::load(&dir.join("sessions.json"));
            for s in sessions.iter_mut().filter(|s| s.status == "running") {
                s.status = "idle".into();
                s.activity = String::new();
            }
            let st: Shared = Arc::new(AppState {
                sessions: Mutex::new(sessions),
                procs: Mutex::new(HashMap::new()),
                settings: Mutex::new(settings),
                hit: Mutex::new([0.0; 4]),
                prev_fg: Mutex::new(0),
                dir,
            });
            app.manage(st.clone());

            if let Some(win) = app.get_webview_window("main") {
                place(&win);
                fg::click_through(&win, true);
            }
            if let Err(e) = app.global_shortcut().register(SHORTCUT) {
                eprintln!("Kısayol kaydedilemedi ({SHORTCUT}): {e}");
            }
            hit_poller(app.handle().clone(), st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            send_prompt,
            cancel_session,
            delete_session,
            mark_read,
            save_settings,
            pick_folder,
            open_terminal,
            set_hit,
            focus_window,
            release_focus,
            ready,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("Ada başlatılamadı");
}
