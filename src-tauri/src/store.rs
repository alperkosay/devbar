// Oturum ve ayar modelleri, JSON dosyalarına okuma/yazma.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Akıştaki tek satır: kullanıcı mesajı, Claude metni, araç çağrısı, sonuç, uyarı ya da hata.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub kind: String,
    pub text: String,
    pub tool: String,
}

impl Item {
    pub fn new(kind: &str, text: impl Into<String>) -> Self {
        Item { kind: kind.into(), text: text.into(), tool: String::new() }
    }
    pub fn tool(name: impl Into<String>, text: impl Into<String>) -> Self {
        Item { kind: "tool".into(), text: text.into(), tool: name.into() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Yeni oturumların açılacağı klasör.
    pub cwd: String,
    /// acceptEdits | plan | bypassPermissions
    pub permission_mode: String,
    /// Boşsa Claude Code'un varsayılanı.
    pub model: String,
}

impl Default for Settings {
    fn default() -> Self {
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
        Settings { cwd: home, permission_mode: "acceptEdits".into(), model: String::new() }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub cwd: String,
    /// Claude Code'un kendi session id'si, `--resume` için.
    pub claude_id: Option<String>,
    /// idle | running | done | warn | error
    pub status: String,
    /// Kapalı adada görünen kısa durum: "Düzenliyor Kurallar.md".
    pub activity: String,
    pub unread: bool,
    pub created: u64,
    pub updated: u64,
    pub cost: f64,
    pub items: Vec<Item>,
}

static SEQ: AtomicU32 = AtomicU32::new(0);

impl Session {
    pub fn new(cwd: &str, prompt: &str) -> Self {
        let first = prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        let t = now();
        Session {
            id: format!("s{}-{}", t, SEQ.fetch_add(1, Ordering::Relaxed)),
            title: truncate(first, 48),
            cwd: cwd.into(),
            status: "idle".into(),
            created: t,
            updated: t,
            ..Default::default()
        }
    }

    /// Akış satırları olmadan kopya; olaylarla her seferinde tüm geçmişi göndermemek için.
    pub fn meta(&self) -> Session {
        Session {
            id: self.id.clone(),
            title: self.title.clone(),
            cwd: self.cwd.clone(),
            claude_id: self.claude_id.clone(),
            status: self.status.clone(),
            activity: self.activity.clone(),
            unread: self.unread,
            created: self.created,
            updated: self.updated,
            cost: self.cost,
            items: Vec::new(),
        }
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max - 1).collect::<String>() + "…"
    }
}

pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save<T: Serialize>(path: &Path, value: &T) {
    let Ok(json) = serde_json::to_string(value) else { return };
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}
