// Claude Code hook'larından gelen olaylarla tüm oturumların (DevBar içi ve dışı) durumunu tutar.
use crate::store::{folder_name, norm_path, now, truncate};
use crate::{save_tabs, Shared};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::AppHandle;

pub const PORT: u16 = 47821;
const MARK: &str = "127.0.0.1:47821/hook";
const EVENTS: [&str; 7] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];

/// Bir Claude Code oturumu.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub session_id: String,
    pub cwd: String,
    pub project: String,
    /// idle | running | waiting | done | ended
    pub status: String,
    pub activity: String,
    /// Barda gösterilen kısa durum: komutun kendisi değil, ne yaptığı ("Komut çalıştırıyor").
    pub short: String,
    /// Son gönderilen prompt, kısaltılmış.
    pub prompt: String,
    pub updated: u64,
    pub unread: bool,
    /// DevBar sekmesiyse sekme id'si.
    pub tab: Option<String>,
    /// Kullanıcının verdiği ad (sekme adı ya da dış oturuma verilen ad); boşsa proje adı.
    pub name: String,
}

/// Oturumun görünen adı: DevBar sekmesiyse sekmenin adı, değilse dış oturuma verilmiş ad.
pub fn name_for(st: &Shared, sid: &str, tab: Option<&str>) -> String {
    if let Some(t) = tab {
        if let Some(n) = st.tabs.lock().unwrap().iter().find(|x| x.id == t).map(|x| x.name.clone()) {
            return n;
        }
    }
    st.names.lock().unwrap().get(sid).cloned().unwrap_or_default()
}

pub fn serve(app: AppHandle, st: Shared) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Hook sunucusu açılamadı (port {PORT}): {e}");
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            // Önce cevap ver ki Claude tarafındaki curl beklemesin.
            let _ = req.respond(tiny_http::Response::empty(200));
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                handle(&app, &st, &v);
            }
        }
    });
}

fn handle(app: &AppHandle, st: &Shared, v: &Value) {
    let Some(sid) = v["session_id"].as_str() else { return };
    let event = v["hook_event_name"].as_str().unwrap_or("");
    let cwd = v["cwd"].as_str().unwrap_or("").to_string();
    let source = v["source"].as_str().unwrap_or("");

    let mut removed: Vec<String> = Vec::new();
    let agent = {
        let mut agents = st.agents.lock().unwrap();
        let known_tab = agents.get(sid).and_then(|a| a.tab.clone());
        let tab = known_tab.or_else(|| link_tab(st, sid, &cwd, source));
        // Sekme yeni bir oturuma geçtiyse (/clear gibi) eskisini listeden çıkar.
        if let Some(t) = &tab {
            agents.retain(|k, a| {
                let stale = k != sid && a.tab.as_deref() == Some(t);
                if stale {
                    removed.push(k.clone());
                }
                !stale
            });
        }
        let a = agents.entry(sid.to_string()).or_insert_with(|| Agent {
            session_id: sid.to_string(),
            status: "idle".into(),
            ..Default::default()
        });
        if !cwd.is_empty() {
            a.project = folder_name(&cwd);
            a.cwd = cwd;
        }
        a.name = name_for(st, sid, tab.as_deref());
        a.tab = tab;

        match event {
            "SessionStart" => {
                a.status = "idle".into();
                a.activity = "Hazır".into();
            }
            "UserPromptSubmit" => {
                a.status = "running".into();
                a.activity = "Düşünüyor…".into();
                a.unread = false;
                let p = v["prompt"].as_str().unwrap_or("").trim();
                a.prompt = truncate(p.lines().next().unwrap_or(""), 90);
                if let Some(t) = &a.tab {
                    mark_used(st, t);
                }
            }
            "PreToolUse" => {
                a.status = "running".into();
                let tool = v["tool_name"].as_str().unwrap_or("Araç");
                a.activity = format!("{} {}", verb(tool), summarize(&v["tool_input"])).trim().to_string();
            }
            "PostToolUse" => {
                a.status = "running".into();
                a.activity = "Düşünüyor…".into();
            }
            "Notification" => {
                let msg = v["message"].as_str().unwrap_or("");
                let kind = v["notification_type"].as_str().unwrap_or("");
                if kind == "permission_prompt" || msg.contains("permission") {
                    a.status = "waiting".into();
                    a.activity = match msg.split("to use ").nth(1) {
                        Some(tool) => format!("İzin bekliyor · {}", tool.trim()),
                        None => "İzin bekliyor".into(),
                    };
                    a.unread = true;
                } else if a.status == "running" {
                    a.status = "waiting".into();
                    a.activity = "Cevabını bekliyor".into();
                    a.unread = true;
                }
            }
            "Stop" => {
                a.status = "done".into();
                a.activity = "Bitti".into();
                a.unread = true;
            }
            "SessionEnd" => {
                a.status = "ended".into();
                a.activity = "Kapandı".into();
            }
            _ => {}
        }
        a.short = if event == "PreToolUse" {
            short_verb(v["tool_name"].as_str().unwrap_or(""))
        } else {
            a.activity.split(" · ").next().unwrap_or("").to_string()
        };
        a.updated = now();
        let out = a.clone();
        if event == "SessionEnd" {
            agents.remove(sid);
        }
        out
    };
    for r in removed {
        crate::emit(app, st, "agent-remove", r);
    }
    #[cfg(debug_assertions)]
    eprintln!("hook {event:<16} {} [{}] {} tab={:?}", agent.project, agent.status, agent.activity, agent.tab);
    crate::emit(app, st, "agent", agent);
}

/// Hook'un geldiği oturumu bir DevBar sekmesine bağlar: önce session id ile, olmazsa aynı
/// klasörde yeni başlamış (ya da /clear yapılmış tek) sekmeyle.
fn link_tab(st: &Shared, sid: &str, cwd: &str, source: &str) -> Option<String> {
    let mut tabs = st.tabs.lock().unwrap();
    if let Some(t) = tabs.iter().find(|t| t.claude_id == sid) {
        return Some(t.id.clone());
    }
    let n = norm_path(cwd);
    let fresh = now().saturating_sub(20_000);
    let candidates: Vec<usize> = tabs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.alive && norm_path(&t.cwd) == n)
        .map(|(i, _)| i)
        .collect();
    let pick = candidates
        .iter()
        .copied()
        .find(|&i| tabs[i].started >= fresh)
        .or_else(|| (source == "clear" && candidates.len() == 1).then(|| candidates[0]))?;
    tabs[pick].claude_id = sid.to_string();
    let id = tabs[pick].id.clone();
    drop(tabs);
    save_tabs(st);
    Some(id)
}

fn mark_used(st: &Shared, tab: &str) {
    let changed = {
        let mut tabs = st.tabs.lock().unwrap();
        match tabs.iter_mut().find(|t| t.id == tab) {
            Some(t) if !t.used => {
                t.used = true;
                true
            }
            _ => false,
        }
    };
    if changed {
        save_tabs(st);
    }
}

/// Araç adından barda gösterilecek kısa, komutsuz ifade.
fn short_verb(name: &str) -> String {
    match name {
        "Read" | "NotebookRead" => "Dosya okuyor",
        "Edit" | "MultiEdit" | "NotebookEdit" => "Dosya düzenliyor",
        "Write" => "Dosya yazıyor",
        "Bash" | "PowerShell" | "BashOutput" => "Komut çalıştırıyor",
        "Grep" | "Glob" => "Kodda arıyor",
        "WebFetch" => "Web sayfası okuyor",
        "WebSearch" => "Web'de arıyor",
        "Task" | "Agent" => "Alt agent çalışıyor",
        "TodoWrite" => "Plan yapıyor",
        n if n.starts_with("mcp__") => "Araç kullanıyor",
        _ => "Çalışıyor",
    }
    .to_string()
}

fn verb(name: &str) -> String {
    match name {
        "Read" | "WebFetch" => "Okuyor",
        "Edit" | "MultiEdit" | "NotebookEdit" => "Düzenliyor",
        "Write" => "Yazıyor",
        "Bash" | "PowerShell" => "Çalıştırıyor",
        "Grep" | "Glob" => "Arıyor",
        "WebSearch" => "Web'de arıyor",
        "Task" | "Agent" => "Alt agent",
        "TodoWrite" => "Plan yapıyor",
        other => return other.strip_prefix("mcp__").map(|r| r.replace("__", " · ")).unwrap_or_else(|| other.to_string()),
    }
    .to_string()
}

fn summarize(input: &Value) -> String {
    let s = |k: &str| input[k].as_str();
    let raw = if let Some(p) = s("file_path").or(s("notebook_path")) {
        folder_name(p)
    } else if let Some(c) = s("command") {
        c.lines().next().unwrap_or("").to_string()
    } else if let Some(p) = s("pattern") {
        p.to_string()
    } else if let Some(u) = s("url") {
        u.trim_start_matches("https://").trim_start_matches("http://").to_string()
    } else if let Some(q) = s("query").or(s("description")) {
        q.to_string()
    } else {
        String::new()
    };
    truncate(raw.trim(), 60)
}

// ---------- Kurulum: ~/.claude/settings.json ----------

fn settings_path() -> PathBuf {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".claude").join("settings.json")
}

fn command() -> String {
    // DevBar kapalıyken curl anında düşer; `|| exit 0` hem bash'te hem cmd'de hatayı yutar.
    format!("curl -s --max-time 1 -X POST -H \"Content-Type: application/json\" --data-binary @- http://{MARK} || exit 0")
}

fn is_ours(entry: &Value) -> bool {
    entry["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(MARK))))
}

fn read_settings() -> Result<Value, String> {
    match std::fs::read_to_string(settings_path()) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| format!("settings.json okunamadı: {e}")),
        _ => Ok(json!({})),
    }
}

fn write_settings(v: &Value) -> Result<(), String> {
    let path = settings_path();
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| e.to_string())
}

pub fn installed() -> bool {
    let Ok(v) = read_settings() else { return false };
    EVENTS.iter().all(|e| v["hooks"][e].as_array().is_some_and(|a| a.iter().any(is_ours)))
}

fn entry(event: &str) -> Value {
    let mut entry = json!({ "hooks": [{ "type": "command", "command": command(), "timeout": 3 }] });
    if event == "PreToolUse" || event == "PostToolUse" {
        entry["matcher"] = json!("*");
    }
    entry
}

/// DevBar'ın kendi sekmeleri için `--settings` ile verilen hook dosyası. Global kurulum
/// yapılmamış olsa da DevBar içindeki oturumların durumu görünür.
pub fn session_settings(dir: &std::path::Path) -> Option<PathBuf> {
    let mut hooks = serde_json::Map::new();
    for e in EVENTS {
        hooks.insert(e.to_string(), json!([entry(e)]));
    }
    let path = dir.join("hooks.json");
    let text = serde_json::to_string_pretty(&json!({ "hooks": hooks })).ok()?;
    std::fs::write(&path, text).ok()?;
    Some(path)
}

pub fn install() -> Result<(), String> {
    let mut v = read_settings()?;
    let path = settings_path();
    let backup = path.with_file_name("settings.json.ada-yedek");
    if path.is_file() && !backup.exists() {
        std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
    }
    if !v.is_object() {
        return Err("settings.json bir JSON nesnesi değil".into());
    }
    if !v["hooks"].is_object() {
        v["hooks"] = json!({});
    }
    for e in EVENTS {
        let mut list: Vec<Value> = v["hooks"][e].as_array().cloned().unwrap_or_default();
        list.retain(|x| !is_ours(x));
        list.push(entry(e));
        v["hooks"][e] = Value::Array(list);
    }
    write_settings(&v)
}

pub fn uninstall() -> Result<(), String> {
    let mut v = read_settings()?;
    let Some(hooks) = v["hooks"].as_object_mut() else { return Ok(()) };
    for e in EVENTS {
        if let Some(list) = hooks.get_mut(e).and_then(|l| l.as_array_mut()) {
            list.retain(|x| !is_ours(x));
            if list.is_empty() {
                hooks.remove(e);
            }
        }
    }
    if hooks.is_empty() {
        v.as_object_mut().map(|o| o.remove("hooks"));
    }
    write_settings(&v)
}
