// Ada: Claude Code oturumları için üstte durum barı ve oturumları yöneten ana pencere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod pty;
mod remote;
mod store;
mod win;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{now, Settings, Tab};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State};

/// Status bar modunda üstte ayrılan şerit (mantıksal piksel). Bar penceresi tam bu boyda;
/// tıklama geçirme gibi hilelere gerek yok. Asıl arayüz ayrı, normal bir pencerede ("app").
const BAR_H: f64 = 30.0;
const SHORTCUT: &str = "ctrl+alt+space";

pub struct AppState {
    pub tabs: Mutex<Vec<Tab>>,
    pub ptys: Mutex<HashMap<String, pty::Pty>>,
    pub agents: Mutex<HashMap<String, hooks::Agent>>,
    pub settings: Mutex<Settings>,
    /// Yüzen ada modunda hap boyutu (mantıksal piksel), bar arayüzü bildirir.
    pub pill: Mutex<(f64, f64)>,
    /// Ana monitör, fiziksel piksel: x, y, w, h.
    pub monitor: Mutex<(i32, i32, i32, i32)>,
    pub dir: PathBuf,
    /// Telefonlara giden olaylar ve sekmelerin ekran tamponu.
    pub hub: remote::Hub,
    /// Masaüstü terminalinin son boyutu (sütun, satır). Telefondan açılan sekmeler bununla başlar.
    pub term_size: Mutex<(u16, u16)>,
}
pub type Shared = Arc<AppState>;

/// Olayı hem masaüstü arayüzüne hem bağlı telefonlara yollar.
pub fn emit<T: Serialize + Clone>(app: &AppHandle, st: &AppState, event: &str, payload: T) {
    st.hub.send(event, &payload);
    let _ = app.emit(event, payload);
}

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

/// Yeni sekme kaydı açar (süreç henüz başlamaz). Masaüstünden ve telefondan ortak kullanılır.
pub fn create_tab(app: &AppHandle, st: &Shared, cwd: Option<String>) -> Result<Tab, String> {
    create_tab_with(app, st, cwd, None)
}

/// `resume` verilirse sekme o Claude oturumuna `--resume` ile bağlanır (dışarıda açılmış
/// bir oturuma Ada'dan devam etmek için).
pub fn create_tab_with(app: &AppHandle, st: &Shared, cwd: Option<String>, resume: Option<String>) -> Result<Tab, String> {
    let dir = cwd.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| st.settings.lock().unwrap().cwd.clone());
    if !Path::new(&dir).is_dir() {
        return Err(format!("Klasör bulunamadı: {dir}"));
    }
    let tab = Tab {
        id: uuid::Uuid::new_v4().to_string(),
        cwd: dir.clone(),
        used: resume.is_some(),
        claude_id: resume.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        ..Default::default()
    };
    st.tabs.lock().unwrap().push(tab.clone());
    save_tabs(st);
    {
        let mut s = st.settings.lock().unwrap();
        let n = store::norm_path(&dir);
        s.recent.retain(|r| store::norm_path(r) != n);
        s.recent.insert(0, dir);
        s.recent.truncate(8);
    }
    save_settings_file(st);
    emit(app, st, "tab", tab.clone());
    Ok(tab)
}

/// Sekmenin claude sürecini başlatır. Daha önce kullanılmışsa `--resume` ile devam eder.
pub fn start_tab(app: &AppHandle, st: &Shared, id: &str, cols: u16, rows: u16) -> Result<Tab, String> {
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
    // Önce sekme olayı: masaüstü terminali, çıktı akmaya başlamadan hazır olsun.
    emit(app, st, "tab", tab.clone());
    if let Err(e) = pty::spawn(app, st, id, &tab.cwd, args, cols.max(20), rows.max(5)) {
        let failed = st.tabs.lock().unwrap().iter_mut().find(|t| t.id == id).map(|t| {
            t.alive = false;
            t.clone()
        });
        if let Some(t) = failed {
            emit(app, st, "tab", t);
        }
        return Err(e);
    }
    save_tabs(st);
    Ok(tab)
}

#[tauri::command]
fn tab_create(app: AppHandle, st: State<'_, Shared>, cwd: Option<String>, resume: Option<String>) -> Result<Tab, String> {
    create_tab_with(&app, &st, cwd, resume)
}

#[tauri::command]
fn tab_start(app: AppHandle, st: State<'_, Shared>, id: String, cols: u16, rows: u16) -> Result<Tab, String> {
    *st.term_size.lock().unwrap() = (cols.max(20), rows.max(5));
    start_tab(&app, &st, &id, cols, rows)
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
        emit(&app, &st, "agent-remove", r);
    }
    st.hub.forget(&id);
    st.hub.send("tab-remove", &id);
}

#[tauri::command]
fn pty_write(st: State<'_, Shared>, id: String, data: String) {
    pty::write(&st, &id, &data);
}

#[tauri::command]
fn pty_resize(st: State<'_, Shared>, id: String, cols: u16, rows: u16) {
    let size = (cols.max(20), rows.max(5));
    *st.term_size.lock().unwrap() = size;
    pty::resize(&st, &id, size.0, size.1);
}

#[tauri::command]
fn agent_read(st: State<'_, Shared>, id: String) {
    if let Some(a) = st.agents.lock().unwrap().get_mut(&id) {
        a.unread = false;
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, st: State<'_, Shared>, mut settings: Settings) {
    let bar_changed = {
        let cur = st.settings.lock().unwrap();
        // Bu alanları arka uç yönetir; arayüzdeki eski kopya üzerine yazmasın.
        settings.recent = cur.recent.clone();
        settings.remote = cur.remote;
        settings.remote_token = cur.remote_token.clone();
        cur.bar != settings.bar
    };
    *st.settings.lock().unwrap() = settings.clone();
    save_settings_file(&st);
    let _ = app.emit("settings", settings);
    if bar_changed {
        place(&app, &st);
    }
}

#[tauri::command]
fn remote_status(st: State<'_, Shared>) -> remote::Info {
    remote::info(&st)
}

/// Telefon erişimini açar ya da kapatır. İlk açılışta token üretilir.
#[tauri::command]
fn remote_set(app: AppHandle, st: State<'_, Shared>, on: bool) -> Result<remote::Info, String> {
    {
        let mut s = st.settings.lock().unwrap();
        s.remote = on;
        if on && s.remote_token.is_empty() {
            s.remote_token = remote::new_token();
        }
    }
    let res = remote::apply(&app, &st);
    if res.is_err() {
        st.settings.lock().unwrap().remote = false;
    }
    save_settings_file(&st);
    res.map(|_| remote::info(&st))
}

/// Yeni token üretir; eski token'la bağlı telefonların akışı kesilir.
#[tauri::command]
fn remote_regen(st: State<'_, Shared>) -> remote::Info {
    st.settings.lock().unwrap().remote_token = remote::new_token();
    save_settings_file(&st);
    st.hub.disconnect_all();
    remote::info(&st)
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
    if let Some(w) = app.get_webview_window("app") {
        d = d.set_parent(&w);
    }
    if let Some(s) = start.filter(|s| Path::new(s).is_dir()) {
        d = d.set_directory(s);
    }
    d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// Ana pencereyi gösterir ve öne getirir. `target`: seçilecek oturum (session id ya da sekme id).
pub fn show_app(app: &AppHandle, target: Option<String>) {
    let Some(w) = app.get_webview_window("app") else { return };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if let Some(t) = target {
        let _ = app.emit_to("app", "select", t);
    }
}

/// Kısayol ve tepsi: ana pencere öndeyse gizler, değilse gösterir.
fn toggle_app(app: &AppHandle) {
    let Some(w) = app.get_webview_window("app") else { return };
    let front = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    if front {
        let _ = w.hide();
    } else {
        show_app(app, None);
    }
}

#[tauri::command]
fn open_app(app: AppHandle, target: Option<String>) {
    show_app(&app, target);
}

#[tauri::command]
fn hide_app(app: AppHandle) {
    if let Some(w) = app.get_webview_window("app") {
        let _ = w.hide();
    }
}

/// Yüzen ada modunda bar arayüzü hap boyutunu bildirir; pencere tam o boya getirilir.
#[tauri::command]
fn bar_size(app: AppHandle, st: State<'_, Shared>, w: f64, h: f64) {
    let changed = {
        let mut p = st.pill.lock().unwrap();
        let c = (p.0 - w).abs() > 0.5 || (p.1 - h).abs() > 0.5;
        *p = (w, h);
        c
    };
    if changed && !st.settings.lock().unwrap().bar {
        place(&app, &st);
    }
}

/// Windows bildirimi (hatırlatıcılar, biten işler).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn ready(app: AppHandle, st: State<'_, Shared>) {
    place(&app, &st);
    if let Some(w) = app.get_webview_window("bar") {
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
    if let Some(w) = app.get_webview_window("bar") {
        win::appbar_remove(&w);
    }
}

/// Bar penceresini yerleştirir: status bar ise ana ekranın üstünde tam genişlik şerit
/// (AppBar ile yer ayrılır), yüzen ada ise üst ortada hap boyunda küçük pencere.
fn place(app: &AppHandle, st: &Shared) {
    let Some(w) = app.get_webview_window("bar") else { return };
    let mon = w.primary_monitor().ok().flatten().or_else(|| w.current_monitor().ok().flatten());
    let Some(mon) = mon else { return };
    let scale = mon.scale_factor();
    let (mx, my) = (mon.position().x, mon.position().y);
    let (mw, mh) = (mon.size().width as i32, mon.size().height as i32);
    *st.monitor.lock().unwrap() = (mx, my, mw, mh);

    let bar = st.settings.lock().unwrap().bar;
    let (x, width, height) = if bar {
        let h = (BAR_H * scale).round() as i32;
        win::appbar_set(&w, mx, my, mw, h);
        (mx, mw, h)
    } else {
        win::appbar_remove(&w);
        let (pw, ph) = *st.pill.lock().unwrap();
        let fw = (pw * scale).round() as i32;
        (mx + (mw - fw) / 2, fw, (ph * scale).round() as i32)
    };
    let _ = w.set_size(PhysicalSize::new(width as u32, height as u32));
    let _ = w.set_position(PhysicalPosition::new(x, my));
    let _ = app.emit("layout", bar);
}

/// Status bar modunda öndeki uygulama tam ekrana geçince (video, oyun) barı gizler.
fn poller(app: AppHandle, st: Shared) {
    std::thread::spawn(move || {
        let mut last_fs = false;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let Some(w) = app.get_webview_window("bar") else { continue };
            let bar = st.settings.lock().unwrap().bar;
            let fs = bar && win::fullscreen_app(&w, *st.monitor.lock().unwrap());
            if fs != last_fs {
                win::set_visible(&w, !fs);
                last_fs = fs;
            }
        }
    });
}

/// Sağ alttaki sistem tepsisinde Ada ikonu: sol tık paneli açar/kapatır, sağ tık menü.
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let toggle = MenuItem::with_id(app, "toggle", "Ada'yı aç", true, Some("Ctrl+Alt+Space"))?;
    let settings = MenuItem::with_id(app, "settings", "Ayarlar", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Ada'yı kapat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &sep, &quit])?;

    let mut b = TrayIconBuilder::with_id("ada").tooltip("Ada").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, e| match e.id.as_ref() {
        "toggle" => show_app(app, None),
        "settings" => {
            show_app(app, None);
            let _ = app.emit_to("app", "open-settings", ());
        }
        "quit" => {
            let st = app.state::<Shared>().inner().clone();
            shutdown(app, &st);
            app.exit(0);
        }
        _ => {}
    })
    .on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            toggle_app(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // İkinci kez açılırsa yeni kopya başlamaz, açık olanın paneli açılır.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_app(app, None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_app(app);
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
                pill: Mutex::new((160.0, 34.0)),
                monitor: Mutex::new((0, 0, 0, 0)),
                dir,
                hub: remote::Hub::default(),
                term_size: Mutex::new((110, 32)),
            });
            app.manage(st.clone());

            if let Err(e) = app.global_shortcut().register(SHORTCUT) {
                eprintln!("Kısayol kaydedilemedi ({SHORTCUT}): {e}");
            }
            hooks::serve(app.handle().clone(), st.clone());
            // Ayarda açık bırakıldıysa telefon erişimini başlat. İlk açılışta token yoksa üret.
            {
                let mut s = st.settings.lock().unwrap();
                if s.remote && s.remote_token.is_empty() {
                    s.remote_token = remote::new_token();
                }
            }
            if let Err(e) = remote::apply(app.handle(), &st) {
                eprintln!("Telefon erişimi açılamadı: {e}");
            }
            poller(app.handle().clone(), st);
            if let Err(e) = tray(app) {
                eprintln!("Tepsi ikonu eklenemedi: {e}");
            }
            Ok(())
        })
        // Ana pencere kapatılınca gizlenir; oturumlar arkada çalışmaya devam eder.
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "app" {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
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
            remote_status,
            remote_set,
            remote_regen,
            idle_seconds,
            log,
            pick_folder,
            open_app,
            hide_app,
            bar_size,
            notify,
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
