// DevBar: Claude Code oturumları için üstte durum barı ve oturumları yöneten ana pencere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod pty;
mod remote;
mod store;
mod sysmon;
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
    /// Açılır kart: gösterilen oturum ve en son ne zaman kapandığı (aynı çipe tekrar
    /// tıklayınca kapansın, yeniden açılmasın diye).
    pub pop: Mutex<(String, Option<std::time::Instant>, f64)>,
    /// Portlar, CPU/RAM, süreçler.
    pub mon: sysmon::Mon,
    /// DevBar dışındaki oturumlara verilen adlar (session id -> ad).
    pub names: Mutex<HashMap<String, String>>,
    /// Ana monitör, fiziksel piksel: x, y, w, h.
    pub monitor: Mutex<(i32, i32, i32, i32)>,
    /// Her monitördeki bar: (pencere etiketi, monitör x/y/genişlik/yükseklik fiziksel, ölçek).
    pub bars: Mutex<Vec<(String, (i32, i32, i32, i32), f64)>>,
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
/// bir oturuma DevBar'dan devam etmek için).
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

/// Oturumu yeniden adlandırır. `target`: sekme id'si ya da (DevBar dışı oturumda) session id.
/// Boş ad, adı kaldırır ve klasör adına döner.
#[tauri::command]
fn rename(app: AppHandle, st: State<'_, Shared>, target: String, name: String) {
    let name = store::truncate(name.trim(), 40);
    let tab = {
        let mut tabs = st.tabs.lock().unwrap();
        tabs.iter_mut().find(|t| t.id == target).map(|t| {
            t.name = name.clone();
            t.clone()
        })
    };
    if let Some(t) = &tab {
        save_tabs(&st);
        emit(&app, &st, "tab", t.clone());
    } else {
        let mut names = st.names.lock().unwrap();
        if name.is_empty() {
            names.remove(&target);
        } else {
            names.insert(target.clone(), name.clone());
        }
        store::save(&st.dir.join("names.json"), &*names);
    }
    // Bağlı oturumların görünen adını güncelle.
    let changed: Vec<hooks::Agent> = {
        let mut agents = st.agents.lock().unwrap();
        agents
            .values_mut()
            .filter(|a| a.session_id == target || a.tab.as_deref() == Some(&target))
            .map(|a| {
                a.name = name.clone();
                a.clone()
            })
            .collect()
    };
    for a in changed {
        emit(&app, &st, "agent", a);
    }
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
    apply_theme(&app, &st);
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

/// Bar temasını değiştirir (menüdeki renk örneklerinden).
#[tauri::command]
fn set_theme(app: AppHandle, st: State<'_, Shared>, theme: String) {
    let settings = {
        let mut s = st.settings.lock().unwrap();
        s.theme = theme;
        s.clone()
    };
    save_settings_file(&st);
    let _ = app.emit("settings", settings);
    apply_theme(&app, &st);
}

/// Liquid temada status bar'ın arkasına Windows akrilik bulanıklığı; diğerlerinde kapalı.
fn apply_theme(app: &AppHandle, st: &Shared) {
    use tauri::window::{Color, Effect, EffectsBuilder};
    let (theme, bar) = {
        let s = st.settings.lock().unwrap();
        (s.theme.clone(), s.bar)
    };
    for w in bar_windows(app) {
        if theme == "liquid" && bar {
            let _ = w.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).color(Color(14, 14, 16, 110)).build());
        } else {
            let _ = w.set_effects(None::<tauri::utils::config::WindowEffectsConfig>);
        }
    }
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

/// Bardan aşağı sarkan çekmece. `kind`: session | menu | ports | docker | git | sys;
/// `left`: bar penceresine göre sol kenar, `w`: genişlik (mantıksal piksel).
#[tauri::command]
fn show_pop(app: AppHandle, st: State<'_, Shared>, window: tauri::WebviewWindow, kind: String, id: Option<String>, left: f64, w: f64) {
    let key = format!("{kind}:{}", id.clone().unwrap_or_default());
    {
        let mut p = st.pop.lock().unwrap();
        // Çekmece açıkken aynı yere tıklamak önce onu kapatır (odak kaybı); hemen yeniden açma.
        if p.0 == key && p.1.is_some_and(|t| t.elapsed() < Duration::from_millis(400)) {
            p.1 = None;
            return;
        }
        *p = (key.clone(), None, w);
    }
    let bar = window;
    let Some(pop) = app.get_webview_window("pop") else { return };
    let (Ok(bp), Ok(bs), Ok(scale)) = (bar.outer_position(), bar.outer_size(), bar.scale_factor()) else { return };
    let (mx, mw) = st
        .bars
        .lock()
        .unwrap()
        .iter()
        .find(|(l, _, _)| l == bar.label())
        .map(|(_, r, _)| (r.0, r.2))
        .unwrap_or((bp.x, bs.width as i32));
    let pw = (w * scale).round() as i32;
    let px = (bp.x + (left * scale) as i32).clamp(mx, mx + mw - pw);
    // Önce o ekrana taşı, sonra boyutla (ekranlar farklı ölçekte olabilir).
    let _ = pop.set_position(PhysicalPosition::new(px, bp.y + bs.height as i32));
    let _ = pop.set_size(PhysicalSize::new(pw as u32, (160.0 * scale) as u32));
    let _ = app.emit_to("pop", "pop-show", serde_json::json!({ "kind": kind, "id": id }));
    let _ = app.emit_to(bar.label(), "pop-open", key);
    let _ = pop.show();
    let _ = pop.set_focus();
}

#[tauri::command]
fn hide_pop(app: AppHandle, st: State<'_, Shared>) {
    st.pop.lock().unwrap().1 = Some(std::time::Instant::now());
    if let Some(pop) = app.get_webview_window("pop") {
        let _ = pop.hide();
    }
    let _ = app.emit("pop-close", ());
}

/// Çekmece içeriğinin yüksekliği değişince pencere de o boya gelir.
#[tauri::command]
fn pop_size(app: AppHandle, st: State<'_, Shared>, h: f64, w: Option<f64>) {
    let w = {
        let mut p = st.pop.lock().unwrap();
        if let Some(w) = w {
            p.2 = w;
        }
        p.2
    };
    if let Some(pop) = app.get_webview_window("pop") {
        let _ = pop.set_size(tauri::LogicalSize::new(w, h.clamp(80.0, 760.0)));
    }
}

// ---------- Geliştirici göstergeleri ----------

#[tauri::command]
async fn sys_ports(st: State<'_, Shared>) -> Result<Vec<sysmon::Port>, String> {
    Ok(st.mon.ports())
}

#[tauri::command]
async fn sys_docker() -> Result<Option<Vec<sysmon::Container>>, String> {
    Ok(sysmon::docker())
}

#[tauri::command]
async fn sys_git(st: State<'_, Shared>) -> Result<Vec<sysmon::Repo>, String> {
    Ok(sysmon::git(&sysmon::project_dirs(&st)))
}

#[tauri::command]
async fn sys_top(st: State<'_, Shared>) -> Result<Vec<(String, u64, usize)>, String> {
    Ok(st.mon.top())
}

#[tauri::command]
async fn sys_kill(pid: u32) -> Result<(), String> {
    sysmon::kill(pid)
}

#[tauri::command]
fn sys_open_url(url: String) -> Result<(), String> {
    sysmon::open_url(&url)
}

#[tauri::command]
fn sys_open_path(kind: String, path: String) -> Result<(), String> {
    sysmon::open_path(&kind, &path)
}

/// Menüden "bu klasörde Claude": ana pencere açılır ve yeni sekme başlar.
#[tauri::command]
fn new_session(app: AppHandle, cwd: String) {
    show_app(&app, None);
    let _ = app.emit_to("app", "new-tab", cwd);
}

/// Bir sekmenin son ekran çıktısı (ham terminal verisi, sütun ve satır sayısı).
#[tauri::command]
fn tab_screen(st: State<'_, Shared>, id: String) -> Option<serde_json::Value> {
    st.hub.screen(&id)
}

#[tauri::command]
fn ready(app: AppHandle, st: State<'_, Shared>, window: tauri::WebviewWindow) {
    place(&app, &st);
    win::set_visible(&window, true);
}

#[tauri::command]
fn quit(app: AppHandle, st: State<'_, Shared>) {
    shutdown(&app, &st);
    app.exit(0);
}

fn shutdown(app: &AppHandle, st: &Shared) {
    pty::kill_all(st);
    let _ = st;
    for w in bar_windows(app) {
        win::appbar_remove(&w);
    }
}

/// Bütün bar pencereleri ("bar" ana ekran, "bar-1", "bar-2"… diğerleri).
fn bar_windows(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l == "bar" || l.starts_with("bar-")).map(|(_, w)| w).collect()
}

/// Her monitör için bir bar: ana ekran yapılandırmadaki "bar", diğerleri burada açılır. Hepsi
/// aynı sayfayı yükler ve aynı olayları dinler, yani her ekranda aynı anda güncellenir.
/// Ekran takılıp çıkarılırsa DevBar yeniden başlatılınca yeni düzene geçer.
fn create_bars(app: &AppHandle, st: &Shared) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let Some(main) = app.get_webview_window("bar") else { return };
    let primary = main.primary_monitor().ok().flatten();
    let mut list = Vec::new();
    let mut n = 0;
    for m in main.available_monitors().unwrap_or_default() {
        let rect = (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32);
        let is_primary = primary.as_ref().is_some_and(|p| p.position() == m.position());
        let label = if is_primary {
            "bar".to_string()
        } else {
            n += 1;
            format!("bar-{n}")
        };
        if !is_primary && app.get_webview_window(&label).is_none() {
            let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
                .title("DevBar bar")
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false)
                .focused(false)
                .position(rect.0 as f64 / m.scale_factor(), rect.1 as f64 / m.scale_factor())
                .inner_size(300.0, 30.0)
                .build();
            if let Err(e) = built {
                eprintln!("Bar penceresi açılamadı ({label}): {e}");
                continue;
            }
        }
        if is_primary {
            *st.monitor.lock().unwrap() = rect;
        }
        list.push((label, rect, m.scale_factor()));
    }
    if list.is_empty() {
        // Monitör bilgisi alınamadıysa en azından ana bar çalışsın.
        if let Ok(Some(m)) = main.primary_monitor() {
            let rect = (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32);
            list.push(("bar".into(), rect, m.scale_factor()));
        }
    }
    *st.bars.lock().unwrap() = list;
}

/// Bar pencerelerini yerleştirir: status bar ise her ekranın üstünde tam genişlik şerit
/// (AppBar ile yer ayrılır), yüzen ada ise her ekranın üst ortasında sekme boyunda pencere.
fn place(app: &AppHandle, st: &Shared) {
    let bar = st.settings.lock().unwrap().bar;
    let (pw, ph) = *st.pill.lock().unwrap();
    for (label, (mx, my, mw, _), scale) in st.bars.lock().unwrap().clone() {
        let Some(w) = app.get_webview_window(&label) else { continue };
        let (x, width, height) = if bar {
            let h = (BAR_H * scale).round() as i32;
            win::appbar_set(&w, mx, my, mw, h);
            (mx, mw, h)
        } else {
            win::appbar_remove(&w);
            let fw = (pw * scale).round() as i32;
            (mx + (mw - fw) / 2, fw, (ph * scale).round() as i32)
        };
        let _ = w.set_position(PhysicalPosition::new(x, my));
        let _ = w.set_size(PhysicalSize::new(width as u32, height as u32));
    }
    let _ = app.emit("layout", bar);
    apply_theme(app, st);
}

/// Status bar modunda bir ekrandaki uygulama tam ekrana geçince (video, oyun) o ekranın barını gizler.
fn poller(app: AppHandle, st: Shared) {
    std::thread::spawn(move || {
        let mut hidden: HashMap<String, bool> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let bar = st.settings.lock().unwrap().bar;
            for (label, rect, _) in st.bars.lock().unwrap().clone() {
                let Some(w) = app.get_webview_window(&label) else { continue };
                let fs = bar && win::fullscreen_app(&w, rect);
                if hidden.get(&label).copied().unwrap_or(false) != fs {
                    win::set_visible(&w, !fs);
                    hidden.insert(label, fs);
                }
            }
        }
    });
}

/// Sağ alttaki sistem tepsisinde DevBar ikonu: sol tık paneli açar/kapatır, sağ tık menü.
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let toggle = MenuItem::with_id(app, "toggle", "DevBar'ı aç", true, Some("Ctrl+Alt+Space"))?;
    let settings = MenuItem::with_id(app, "settings", "Ayarlar", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "DevBar'ı kapat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &sep, &quit])?;

    let mut b = TrayIconBuilder::with_id("ada").tooltip("DevBar").menu(&menu).show_menu_on_left_click(false);
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
            let names: HashMap<String, String> = store::load(&dir.join("names.json"));
            for t in tabs.iter_mut() {
                t.alive = false;
            }
            let st: Shared = Arc::new(AppState {
                tabs: Mutex::new(tabs),
                ptys: Mutex::new(HashMap::new()),
                agents: Mutex::new(HashMap::new()),
                settings: Mutex::new(settings),
                pill: Mutex::new((160.0, 34.0)),
                pop: Mutex::new((String::new(), None, 440.0)),
                mon: sysmon::Mon::default(),
                names: Mutex::new(names),
                monitor: Mutex::new((0, 0, 0, 0)),
                bars: Mutex::new(Vec::new()),
                dir,
                hub: remote::Hub::default(),
                term_size: Mutex::new((110, 32)),
            });
            app.manage(st.clone());
            create_bars(app.handle(), &st);

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
            sysmon::start(app.handle().clone(), st.clone());
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
            show_pop,
            hide_pop,
            pop_size,
            rename,
            set_theme,
            sys_ports,
            sys_docker,
            sys_git,
            sys_top,
            sys_kill,
            sys_open_url,
            sys_open_path,
            new_session,
            tab_screen,
            ready,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("DevBar başlatılamadı");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let st = app.state::<Shared>().inner().clone();
            shutdown(app, &st);
        }
    });
}
