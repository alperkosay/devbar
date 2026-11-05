// Tek bir `claude -p` sürecini başlatır, stream-json çıktısını oturum güncellemelerine çevirir.
use crate::store::{truncate, Item, Settings};
use crate::{apply, save_sessions, Shared};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use tauri::AppHandle;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
pub const NO_WINDOW: u32 = 0x0800_0000;

pub fn start(app: AppHandle, st: Shared, sid: String, cwd: String, prompt: String, resume: Option<String>, settings: Settings) {
    std::thread::spawn(move || run(app, st, sid, cwd, prompt, resume, settings));
}

fn run(app: AppHandle, st: Shared, sid: String, cwd: String, prompt: String, resume: Option<String>, settings: Settings) {
    let mut cmd = Command::new("claude");
    cmd.args(["-p", "--output-format", "stream-json", "--verbose"]);
    match settings.permission_mode.as_str() {
        "bypassPermissions" => {
            cmd.arg("--dangerously-skip-permissions");
        }
        "" => {}
        mode => {
            cmd.args(["--permission-mode", mode]);
        }
    }
    if !settings.model.is_empty() {
        cmd.args(["--model", &settings.model]);
    }
    if let Some(id) = &resume {
        cmd.args(["--resume", id]);
    }
    cmd.current_dir(&cwd)
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("claude başlatılamadı ({e}). Claude Code kurulu ve PATH'te mi, klasör duruyor mu?");
            finish(&app, &st, &sid, "error", "Başlatılamadı", Item::new("error", msg));
            return;
        }
    };
    st.procs.lock().unwrap().insert(sid.clone(), child.id());

    // Prompt stdin'den gider: Windows'ta tırnak ve uzunluk sorunu olmaz. Kapanınca EOF olur.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut s);
        }
        s
    });

    let mut got_result = false;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                got_result |= handle(&app, &st, &sid, &v);
            }
        }
    }
    let _ = child.wait();
    let err = err_thread.join().unwrap_or_default();
    // cancel_session pid'i önceden siler; burada yoksa kullanıcı durdurmuştur.
    let cancelled = st.procs.lock().unwrap().remove(&sid).is_none();

    if cancelled {
        finish(&app, &st, &sid, "idle", "Durduruldu", Item::new("warn", "Durduruldu"));
    } else if !got_result {
        let tail: String = {
            let t = err.trim();
            let n = t.chars().count();
            t.chars().skip(n.saturating_sub(600)).collect()
        };
        let msg = if tail.is_empty() { "Claude beklenmedik şekilde kapandı".to_string() } else { tail };
        finish(&app, &st, &sid, "error", "Hata", Item::new("error", msg));
    } else {
        save_sessions(&st);
    }
}

fn finish(app: &AppHandle, st: &Shared, sid: &str, status: &str, activity: &str, item: Item) {
    apply(app, st, sid, vec![item], |s| {
        s.status = status.into();
        s.activity = activity.into();
        s.unread = status != "idle";
    });
    save_sessions(st);
}

/// Bir stream-json satırını işler. Sonuç (result) satırıysa true döner.
fn handle(app: &AppHandle, st: &Shared, sid: &str, v: &Value) -> bool {
    match v["type"].as_str().unwrap_or("") {
        "system" if v["subtype"] == "init" => {
            let cid = v["session_id"].as_str().map(String::from);
            apply(app, st, sid, vec![], |s| {
                if cid.is_some() {
                    s.claude_id = cid;
                }
                s.activity = "Düşünüyor…".into();
            });
        }
        "assistant" => {
            let mut items = Vec::new();
            let mut activity = None;
            for c in v["message"]["content"].as_array().into_iter().flatten() {
                match c["type"].as_str().unwrap_or("") {
                    "text" => {
                        let t = c["text"].as_str().unwrap_or("").trim();
                        if !t.is_empty() {
                            items.push(Item::new("text", t));
                            activity = Some("Yazıyor…".to_string());
                        }
                    }
                    "tool_use" => {
                        let name = c["name"].as_str().unwrap_or("Araç");
                        let sum = summarize(&c["input"]);
                        activity = Some(format!("{} {}", verb(name), sum).trim().to_string());
                        items.push(Item::tool(short_name(name), sum));
                    }
                    "thinking" => activity = Some("Düşünüyor…".to_string()),
                    _ => {}
                }
            }
            apply(app, st, sid, items, |s| {
                if let Some(a) = activity {
                    s.activity = a;
                }
            });
        }
        "user" => {
            // Araç bitti, Claude sıradakini düşünüyor.
            apply(app, st, sid, vec![], |s| s.activity = "Düşünüyor…".into());
        }
        "result" => {
            let subtype = v["subtype"].as_str().unwrap_or("");
            let ok = !v["is_error"].as_bool().unwrap_or(false) && subtype == "success";
            let ms = v["duration_ms"].as_u64().unwrap_or(0);
            let cost = v["total_cost_usd"].as_f64().unwrap_or(0.0);
            let cid = v["session_id"].as_str().map(String::from);
            let denied = denials(v);

            let mut items = Vec::new();
            if !ok {
                let text = v["result"].as_str().filter(|t| !t.trim().is_empty()).map(String::from);
                items.push(Item::new("error", text.unwrap_or_else(|| format!("Claude hatayla bitti ({subtype})"))));
            }
            if !denied.is_empty() {
                items.push(Item::new("warn", format!("İzin verilmedi: {}", denied.join("  ·  "))));
            }
            if ok {
                items.push(Item::new("result", format!("{} · ${:.2}", duration(ms), cost)));
            }
            let status = if !ok { "error" } else if !denied.is_empty() { "warn" } else { "done" };
            apply(app, st, sid, items, |s| {
                s.status = status.into();
                s.activity = match status {
                    "done" => format!("Bitti · {}", duration(ms)),
                    "warn" => "Bitti, bazı izinler reddedildi".into(),
                    _ => "Hata".into(),
                };
                s.unread = true;
                s.cost += cost;
                if cid.is_some() {
                    s.claude_id = cid;
                }
            });
            return true;
        }
        _ => {}
    }
    false
}

fn duration(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s} sn")
    } else {
        format!("{} dk {} sn", s / 60, s % 60)
    }
}

fn short_name(name: &str) -> String {
    match name.strip_prefix("mcp__") {
        Some(rest) => rest.replace("__", " · "),
        None => name.to_string(),
    }
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
        other => return short_name(other),
    }
    .to_string()
}

/// Araç girdisinden tek satırlık özet: dosya adı, komut, arama deseni...
fn summarize(input: &Value) -> String {
    let s = |k: &str| input[k].as_str();
    let raw = if let Some(p) = s("file_path").or(s("notebook_path")) {
        file_name(p)
    } else if let Some(c) = s("command") {
        c.lines().next().unwrap_or("").to_string()
    } else if let Some(p) = s("pattern") {
        p.to_string()
    } else if let Some(u) = s("url") {
        u.trim_start_matches("https://").trim_start_matches("http://").to_string()
    } else if let Some(q) = s("query").or(s("description")) {
        q.to_string()
    } else if let Some(p) = s("path") {
        file_name(p)
    } else {
        String::new()
    };
    truncate(raw.trim(), 70)
}

fn file_name(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

fn denials(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in v["permission_denials"].as_array().into_iter().flatten() {
        let input = &d["tool_input"];
        let raw = input["command"]
            .as_str()
            .or(input["file_path"].as_str())
            .or(d["tool_name"].as_str())
            .unwrap_or("?");
        let line = truncate(raw.lines().next().unwrap_or("").trim(), 60);
        if !out.contains(&line) {
            out.push(line);
        }
    }
    out.truncate(4);
    out
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}
