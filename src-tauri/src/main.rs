// Ada: ekranın tepesinde duran, Claude Code oturumlarını yöneten bar ve ada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod pty;
mod store;
mod win;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{now, Settings, Tab};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State};

/// Yüzen ada modunda pencere boyutu (mantıksal piksel). Pencere sabit ve şeffaf;
/// ada CSS ile büyür, dışındaki alan tıklamaları alttaki uygulamaya geçirir.
const FLOAT_W: f64 = 960.0;
const FLOAT_H: f64 = 640.0;
/// Status bar modunda ayrılan şerit ve altında panelin açılacağı alan.
const BAR_H: f64 = 30.0;
const DROP_H: f64 = 610.0;
const SHORTCUT: &str = "ctrl+alt+space";

pub struct AppState {
    pub tabs: Mutex<Vec<Tab>>,
    pub ptys: Mutex<HashMap<String, pty::Pty>>,
    pub agents: Mutex<HashMap<String, hooks::Agent>>,
    pub settings: Mutex<Settings>,
    /// Tıklanabilir alanlar, pencereye göre mantıksal piksel: [x, y, w, h].
    pub hits: Mutex<Vec<[f64; 4]>>,
    /// Ada açılmadan önce odakta olan pencere.
    pub prev_fg: Mutex<isize>,
    /// Ana monitör, fiziksel piksel: x, y, w, h.
    pub monitor: Mutex<(i32, i32, i32, i32)>,
    pub dir: PathBuf,
}
pub type Shared = Arc<AppState>;

pub fn save_tabs(st: &AppState) {
    let tabs = st.tabs.lock().unwrap();
    store::save(&st.dir.join("tabs.json"), &*tabs);
}

fn save_settings_file(st: &AppState) {
    let s = st.settings.lock().unwrap();
    store::save(&st.dir.join("settings.json"), &*s);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    settings: Settings,
    tabs: Vec<Tab>,
    agents: Vec<hooks::Agent>,
    hooks: bool,
}

#[tauri::command]
fn get_state(st: State<'_, Shared>) -> Snapshot {
    Snapshot {
        settings: st.settings.lock().unwrap().clone(),
        tabs: st.tabs.lock().unwrap().clone(),
        agents: st.agents.lock().unwrap().values().cloned().collect(),
        hooks: hooks::installed(),
    }
}

/// Yeni sekme kaydı açar (süreç henüz başlamaz; arayüz terminal boyutunu ölçünce tab_start çağırır).
#[tauri::command]
fn tab_create(st: State<'_, Shared>, cwd: Option<String>) -> Result<Tab, String> {
    let dir = cwd.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| st.settings.lock().unwrap().cwd.clone());
    if !Path::new(&dir).is_dir() {
        return Err(format!("Klasör bulunamadı: {dir}"));
    }
    let tab = Tab {
        id: uuid::Uuid::new_v4().to_string(),
        cwd: dir.clone(),
        claude_id: uuid::Uuid::new_v4().to_string(),
        ..Default::default()
    };
    st.tabs.lock().unwrap().push(tab.clone());
    save_tabs(&st);
    {
        let mut s = st.settings.lock().unwrap();
        let n = store::norm_path(&dir);
        s.recent.retain(|r| store::norm_path(r) != n);
        s.recent.insert(0, dir);
        s.recent.truncate(8);
    }
    save_settings_file(&st);
    Ok(tab)
}

/// Sekmenin claude sürecini başlatır. Daha önce kullanılmışsa `--resume` ile devam eder.
#[tauri::command]
fn tab_start(app: AppHandle, st: State<'_, Shared>, id: String, cols: u16, rows: u16) -> Result<Tab, String> {
    let settings = st.settings.lock().unwrap().clone();
    let (tab, args) = {
        let mut tabs = st.tabs.lock().unwrap();
        let t = tabs.iter_mut().find(|t| t.id == id).ok_or("Sekme yok")?;
        if t.alive {
            return Ok(t.clone());
        }
        let mut args: Vec<String> = Vec::new();
        if t.used {
            args.extend(["--resume".into(), t.claude_id.clone()]);
        } else {
            // Hiç prompt gönderilmemiş oturum diske yazılmamış olabilir; temiz bir id ile başla.
            t.claude_id = uuid::Uuid::new_v4().to_string();
            args.extend(["--session-id".into(), t.claude_id.clone()]);
        }
        match settings.permission_mode.as_str() {
            "" => {}
            "bypassPermissions" => args.push("--dangerously-skip-permissions".into()),
            m => args.extend(["--permission-mode".into(), m.into()]),
        }
        if !settings.model.is_empty() {
            args.extend(["--model".into(), settings.model.clone()]);
        }
        // Global hook'lar kurulu değilse bu oturuma özel ver; kuruluysa iki kez bildirmesin.
        if !hooks::installed() {
            if let Some(p) = hooks::session_settings(&st.dir) {
                args.extend(["--settings".into(), p.to_string_lossy().into_owned()]);
            }
        }
        t.alive = true;
        t.started = now();
        (t.clone(), args)
    };
    if let Err(e) = pty::spawn(&app, &st, &id, &tab.cwd, args, cols.max(20), rows.max(5)) {
        if let Some(t) = st.tabs.lock().unwrap().iter_mut().find(|t| t.id == id) {
            t.alive = false;
        }
        return Err(e);
    }
    save_tabs(&st);
    Ok(tab)
}

#[tauri::command]
fn tab_close(app: AppHandle, st: State<'_, Shared>, id: String) {
    pty::kill(&st, &id);
    st.tabs.lock().unwrap().retain(|t| t.id != id);
    save_tabs(&st);
    let removed: Vec<String> = {
        let mut agents = st.agents.lock().unwrap();
        let ids: Vec<String> = agents.iter().filter(|(_, a)| a.tab.as_deref() == Some(&id)).map(|(k, _)| k.clone()).collect();
        for k in &ids {
            agents.remove(k);
        }
        ids
    };
    for r in removed {
        let _ = app.emit("agent-remove", r);
    }
}

#[tauri::command]
fn pty_write(st: State<'_, Shared>, id: String, data: String) {
    pty::write(&st, &id, &data);
}

#[tauri::command]
fn pty_resize(st: State<'_, Shared>, id: String, cols: u16, rows: u16) {
    pty::resize(&st, &id, cols.max(20), rows.max(5));
}

#[tauri::command]
fn agent_read(st: State<'_, Shared>, id: String) {
    if let Some(a) = st.agents.lock().unwrap().get_mut(&id) {
        a.unread = false;
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, st: State<'_, Shared>, settings: Settings) {
    let bar_changed = st.settings.lock().unwrap().bar != settings.bar;
    *st.settings.lock().unwrap() = settings;
    save_settings_file(&st);
    if bar_changed {
        place(&app, &st);
    }
}

#[tauri::command]
fn hooks_install() -> Result<bool, String> {
    hooks::install()?;
    Ok(hooks::installed())
}

#[tauri::command]
fn hooks_uninstall() -> Result<bool, String> {
    hooks::uninstall()?;
    Ok(hooks::installed())
}

/// Arayüzdeki hataları terminal çıktısına yazar.
#[tauri::command]
fn log(msg: String) {
    eprintln!("[ui] {msg}");
}

#[tauri::command]
fn idle_seconds() -> u64 {
    win::idle_seconds()
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

#[tauri::command]
fn set_hits(st: State<'_, Shared>, rects: Vec<[f64; 4]>) {
    *st.hits.lock().unwrap() = rects;
}

/// Ada açılınca odağı alır; önceki pencereyi hatırlar ki kapanınca odak ona dönsün.
#[tauri::command]
fn focus_window(app: AppHandle, st: State<'_, Shared>) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_focused().unwrap_or(false) {
        return;
    }
    *st.prev_fg.lock().unwrap() = win::foreground();
    let _ = w.set_focus();
}

/// Kısayolla kapanınca odağı önceki uygulamaya geri verir.
#[tauri::command]
fn release_focus(app: AppHandle, st: State<'_, Shared>) {
    let prev = std::mem::take(&mut *st.prev_fg.lock().unwrap());
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if prev != 0 && focused {
        win::restore_foreground(prev);
    }
}

#[tauri::command]
fn ready(app: AppHandle, st: State<'_, Shared>) {
    place(&app, &st);
    if let Some(w) = app.get_webview_window("main") {
        win::set_visible(&w, true);
    }
}

#[tauri::command]
fn quit(app: AppHandle, st: State<'_, Shared>) {
    shutdown(&app, &st);
    app.exit(0);
}

fn shutdown(app: &AppHandle, st: &Shared) {
    pty::kill_all(st);
    if let Some(w) = app.get_webview_window("main") {
        win::appbar_remove(&w);
    }
}

/// Pencereyi moda göre yerleştirir: status bar ise ekranın tüm genişliği ve üstte ayrılmış
/// şerit, yüzen ada ise üst ortada sabit kutu.
fn place(app: &AppHandle, st: &Shared) {
    let Some(w) = app.get_webview_window("main") else { return };
    let mon = w.primary_monitor().ok().flatten().or_else(|| w.current_monitor().ok().flatten());
    let Some(mon) = mon else { return };
    let scale = mon.scale_factor();
    let (mx, my) = (mon.position().x, mon.position().y);
    let (mw, mh) = (mon.size().width as i32, mon.size().height as i32);
    *st.monitor.lock().unwrap() = (mx, my, mw, mh);

    let bar = st.settings.lock().unwrap().bar;
    let (x, width, height) = if bar {
        win::appbar_set(&w, mx, my, mw, (BAR_H * scale).round() as i32);
        (mx, mw, ((BAR_H + DROP_H) * scale).round() as i32)
    } else {
        win::appbar_remove(&w);
        let fw = (FLOAT_W * scale).round() as i32;
        (mx + (mw - fw) / 2, fw, (FLOAT_H * scale).round() as i32)
    };
    let _ = w.set_size(PhysicalSize::new(width as u32, height as u32));
    let _ = w.set_position(PhysicalPosition::new(x, my));
    let _ = app.emit("layout", bar);
}

/// İmleç tıklanabilir alanlardan birindeyse pencere tıklama alır, değilse tıklamalar alttaki
/// uygulamaya geçer. Status bar modunda tam ekran uygulama açılınca bar gizlenir.
fn poller(app: AppHandle, st: Shared) {
    std::thread::spawn(move || {
        let mut last_inside: Option<bool> = None;
        let mut last_fs = false;
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            tick = tick.wrapping_add(1);
            let Some(w) = app.get_webview_window("main") else { continue };

            if tick % 12 == 0 {
                let bar = st.settings.lock().unwrap().bar;
                let fs = bar && win::fullscreen_app(&w, *st.monitor.lock().unwrap());
                if fs != last_fs {
                    win::set_visible(&w, !fs);
                    last_fs = fs;
                }
            }

            let (Ok(c), Ok(p), Ok(scale)) = (app.cursor_position(), w.outer_position(), w.scale_factor()) else {
                continue;
            };
            let lx = (c.x - p.x as f64) / scale;
            let ly = (c.y - p.y as f64) / scale;
            let inside = st.hits.lock().unwrap().iter().any(|[x, y, w, h]| lx >= *x && lx <= x + w && ly >= *y && ly <= y + h);
            if last_inside != Some(inside) {
                win::click_through(&w, !inside);
                last_inside = Some(inside);
            }
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
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
            let mut tabs: Vec<Tab> = store::load(&dir.join("tabs.json"));
            for t in tabs.iter_mut() {
                t.alive = false;
            }
            let st: Shared = Arc::new(AppState {
                tabs: Mutex::new(tabs),
                ptys: Mutex::new(HashMap::new()),
                agents: Mutex::new(HashMap::new()),
                settings: Mutex::new(settings),
                hits: Mutex::new(Vec::new()),
                prev_fg: Mutex::new(0),
                monitor: Mutex::new((0, 0, 0, 0)),
                dir,
            });
            app.manage(st.clone());

            if let Some(w) = app.get_webview_window("main") {
                win::click_through(&w, true);
            }
            if let Err(e) = app.global_shortcut().register(SHORTCUT) {
                eprintln!("Kısayol kaydedilemedi ({SHORTCUT}): {e}");
            }
            hooks::serve(app.handle().clone(), st.clone());
            poller(app.handle().clone(), st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            tab_create,
            tab_start,
            tab_close,
            pty_write,
            pty_resize,
            agent_read,
            save_settings,
            hooks_install,
            hooks_uninstall,
            idle_seconds,
            log,
            pick_folder,
            set_hits,
            focus_window,
            release_focus,
            ready,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("Ada başlatılamadı");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let st = app.state::<Shared>().inner().clone();
            shutdown(app, &st);
        }
    });
}
