// Ayarlar, sekmeler ve JSON dosyalarına okuma/yazma.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Reminder {
    pub id: String,
    /// water | stand | eye | bell
    pub icon: String,
    pub text: String,
    pub minutes: u32,
    pub on: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Yeni oturumların varsayılan klasörü.
    pub cwd: String,
    /// Boş: Claude Code'un kendi ayarı. Yoksa acceptEdits | plan | bypassPermissions
    pub permission_mode: String,
    /// Boşsa Claude Code'un varsayılanı.
    pub model: String,
    /// true: ekranın üstünde yer ayıran status bar, false: yüzen ada.
    pub bar: bool,
    /// Son açılan klasörler, en yeni başta.
    pub recent: Vec<String>,
    pub reminders: Vec<Reminder>,
    /// Telefon erişimi (LAN'da PWA + API). Varsayılan kapalı.
    pub remote: bool,
    /// Telefonun API'ye erişmek için kullandığı gizli anahtar (64 hex karakter).
    pub remote_token: String,
}

impl Default for Settings {
    fn default() -> Self {
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
        let r = |id: &str, icon: &str, text: &str, minutes: u32, on: bool| Reminder {
            id: id.into(),
            icon: icon.into(),
            text: text.into(),
            minutes,
            on,
        };
        Settings {
            cwd: home,
            permission_mode: String::new(),
            model: String::new(),
            bar: true,
            recent: Vec::new(),
            reminders: vec![
                r("water", "water", "Su iç", 30, true),
                r("stand", "stand", "Ayağa kalk, biraz yürü", 60, true),
                r("eye", "eye", "20 saniye uzağa bak", 20, false),
            ],
            remote: false,
            remote_token: String::new(),
        }
    }
}

/// DevBar içindeki bir terminal sekmesi.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Tab {
    pub id: String,
    /// Kullanıcının verdiği ad; boşsa klasör adı gösterilir.
    pub name: String,
    pub cwd: String,
    /// Claude Code session id. Yeni sekmede DevBar üretir (`--session-id`), sonra hook'larla güncellenir.
    pub claude_id: String,
    /// İçinde en az bir prompt gönderildi mi; gönderildiyse yeniden açarken `--resume` kullanılır.
    pub used: bool,
    /// Süreç çalışıyor mu (diske yazılsa da açılışta false olur).
    pub alive: bool,
    pub started: u64,
}

pub fn folder_name(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// Klasör karşılaştırması için: küçük harf, ters bölü, sonda ayraç yok.
pub fn norm_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
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
    let Ok(json) = serde_json::to_string_pretty(value) else { return };
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}
