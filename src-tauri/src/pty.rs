// Sekme başına bir sahte terminal (Windows'ta ConPTY) içinde etkileşimli `claude`.
use crate::{save_tabs, Shared};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Serialize, Clone)]
struct Data<'a> {
    id: &'a str,
    data: String,
}

/// PATH'te claude.exe (ya da claude.cmd) arar. Bulamazsa "claude" döner.
fn claude_path() -> (PathBuf, bool) {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for (name, is_cmd) in [("claude.exe", false), ("claude.cmd", true), ("claude", false)] {
                let p = dir.join(name);
                if p.is_file() {
                    return (p, is_cmd);
                }
            }
        }
    }
    (PathBuf::from("claude"), false)
}

pub fn spawn(app: &AppHandle, st: &Shared, id: &str, cwd: &str, args: Vec<String>, cols: u16, rows: u16) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let (exe, is_cmd) = claude_path();
    let mut cmd = if is_cmd {
        let mut c = CommandBuilder::new("cmd");
        c.arg("/c");
        c.arg(&exe);
        c
    } else {
        CommandBuilder::new(&exe)
    };
    cmd.args(&args);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Ada bir Claude oturumunun içinden başlatıldıysa oturuma özel değişkenler sızmasın;
    // yoksa yeni claude kendini alt oturum sanıp transcript kaydetmiyor.
    for key in [
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_SSE_PORT",
    ] {
        cmd.env_remove(key);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("claude başlatılamadı: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    st.ptys.lock().unwrap().insert(id.to_string(), Pty { master: pair.master, writer, killer });
    st.hub.size(id, cols, rows);

    // Çıktıyı okuyup arayüze akıt. UTF-8 karakterleri parça sınırında bölünebilir, artanı sakla.
    let app2 = app.clone();
    let st2 = st.clone();
    let id2 = id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(), // gerçekten bozuk bayt: kayıplı çevir
                    };
                    let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !data.is_empty() {
                        // Telefon tamponu ve canlı akış; sonra masaüstü terminali.
                        st2.hub.pty(&id2, &data);
                        let _ = app2.emit("pty", Data { id: &id2, data });
                    }
                }
            }
        }
    });

    // ConPTY süreç bitince okuyucuya EOF vermiyor; süreci bekleyip master'ı bırakıyoruz.
    let app3 = app.clone();
    let st3 = st.clone();
    let id3 = id.to_string();
    std::thread::spawn(move || {
        let _ = child.wait();
        st3.ptys.lock().unwrap().remove(&id3);
        let tab = st3.tabs.lock().unwrap().iter_mut().find(|t| t.id == id3).map(|t| {
            t.alive = false;
            t.clone()
        });
        save_tabs(&st3);
        st3.hub.pty(&id3, "\r\n\x1b[90m[oturum kapandı]\x1b[0m\r\n");
        let _ = app3.emit("pty-exit", &id3);
        if let Some(t) = tab {
            st3.hub.send("tab", &t);
        }
    });
    Ok(())
}

/// Sekme çalışmıyorsa false döner.
pub fn write(st: &Shared, id: &str, data: &str) -> bool {
    match st.ptys.lock().unwrap().get_mut(id) {
        Some(p) => p.writer.write_all(data.as_bytes()).and_then(|_| p.writer.flush()).is_ok(),
        None => false,
    }
}

pub fn resize(st: &Shared, id: &str, cols: u16, rows: u16) {
    let ok = match st.ptys.lock().unwrap().get(id) {
        Some(p) => p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).is_ok(),
        None => false,
    };
    // ptys kilidi bırakıldıktan sonra (kilit sırası: Hub en dışta).
    if ok {
        st.hub.size(id, cols, rows);
    }
}

pub fn kill(st: &Shared, id: &str) {
    if let Some(p) = st.ptys.lock().unwrap().get_mut(id) {
        let _ = p.killer.kill();
    }
}

pub fn kill_all(st: &Shared) {
    for p in st.ptys.lock().unwrap().values_mut() {
        let _ = p.killer.kill();
    }
}
