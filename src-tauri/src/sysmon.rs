// Geliştirici göstergeleri: açık portlar (hangi süreç, hangi proje), Docker, git, CPU/RAM.
// Bilgiler Windows'un kendi araçlarından (netstat, git, docker) ve sysinfo'dan okunur.
use crate::store::{folder_name, truncate};
use crate::Shared;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub struct Mon {
    sys: Mutex<System>,
    nets: Mutex<Networks>,
}

impl Default for Mon {
    fn default() -> Self {
        Mon { sys: Mutex::new(System::new()), nets: Mutex::new(Networks::new_with_refreshed_list()) }
    }
}

/// Komutu pencere açmadan çalıştırır, başarılıysa çıktısını verir.
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let out = c.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Komutu arka planda başlatır (tarayıcı, VS Code, klasör…).
fn launch(cmd: &str, args: &[&str]) -> Result<(), String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------- Portlar ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub port: u16,
    pub addr: String,
    pub pid: u32,
    pub name: String,
    /// Tahmini tür: Node, Python, PostgreSQL, Docker…
    pub kind: String,
    pub project: String,
    pub cwd: String,
    pub cmd: String,
    /// Windows'un kendi servisleri (svchost, System…): varsayılan gizli.
    pub system: bool,
    /// Bilinen bir geliştirme aracı (Node, Python, veritabanı, Docker…).
    pub dev: bool,
}

/// TCP'de dinleyen (adres, port, pid). Durum yazısı dile göre değiştiği için uzak adresin
/// `:0` olmasına bakılır.
fn listening() -> Vec<(String, u16, u32)> {
    let Some(out) = run("netstat", &["-ano", "-p", "TCP"]).or_else(|| run("netstat", &["-ano"])) else { return vec![] };
    let out6 = run("netstat", &["-ano", "-p", "TCPv6"]).unwrap_or_default();
    let mut seen = HashSet::new();
    let mut res = Vec::new();
    for line in out.lines().chain(out6.lines()) {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() < 5 || !p[0].starts_with("TCP") || !(p[2].ends_with(":0") || p[2].ends_with(":*")) {
            continue;
        }
        let Some((addr, port)) = p[1].rsplit_once(':') else { continue };
        let (Ok(port), Ok(pid)) = (port.parse::<u16>(), p[p.len() - 1].parse::<u32>()) else { continue };
        if seen.insert((port, pid)) {
            res.push((addr.trim_matches(['[', ']']).to_string(), port, pid));
        }
    }
    res
}

const SYSTEM_PROCS: [&str; 10] =
    ["system", "svchost.exe", "lsass.exe", "wininit.exe", "services.exe", "spoolsv.exe", "idle", "registry", "smss.exe", "searchhost.exe"];

fn guess_kind(name: &str, cmd: &str, port: u16) -> &'static str {
    let n = name.to_lowercase();
    let c = cmd.to_lowercase();
    let has = |s: &str| n.contains(s);
    if has("node") || has("bun") || has("deno") {
        if c.contains("vite") {
            return "Vite";
        }
        if c.contains("next") {
            return "Next.js";
        }
        return "Node";
    }
    if has("python") || has("uvicorn") {
        return "Python";
    }
    if has("postgres") || port == 5432 {
        return "PostgreSQL";
    }
    if has("redis") || has("valkey") || port == 6379 {
        return "Redis";
    }
    if has("mysqld") || has("mariadb") || port == 3306 {
        return "MySQL";
    }
    if has("mongod") || port == 27017 {
        return "MongoDB";
    }
    if has("docker") || has("wslrelay") || has("vpnkit") {
        return "Docker";
    }
    if has("java") {
        return "Java";
    }
    if has("dotnet") || has("iisexpress") {
        return ".NET";
    }
    if has("php") {
        return "PHP";
    }
    if has("devbar") {
        return "DevBar";
    }
    if has("code") {
        return "VS Code";
    }
    if has("claude") {
        return "Claude";
    }
    ""
}

impl Mon {
    /// Dinleyen portlar ve onları açan süreçler. Geliştirme süreçleri önce, sonra port sırası.
    pub fn ports(&self) -> Vec<Port> {
        let list = listening();
        let pids: Vec<Pid> = list.iter().map(|(_, _, p)| Pid::from_u32(*p)).collect::<HashSet<_>>().into_iter().collect();
        let mut sys = self.sys.lock().unwrap();
        let kind = ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, kind);

        let mut out: Vec<Port> = list
            .into_iter()
            .map(|(addr, port, pid)| {
                let p = sys.process(Pid::from_u32(pid));
                let name = p.map(|p| p.name().to_string_lossy().into_owned()).unwrap_or_else(|| if pid == 4 { "System".into() } else { format!("PID {pid}") });
                let cwd = p.and_then(|p| p.cwd()).map(|c| c.to_string_lossy().into_owned()).unwrap_or_default();
                let cmd = p
                    .map(|p| p.cmd().iter().skip(1).map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default();
                let lower = name.to_lowercase();
                let system = pid <= 4 || SYSTEM_PROCS.contains(&lower.as_str());
                // Windows klasörleri ya da kullanıcı kök klasörü proje sayılmaz.
                let cwd_l = cwd.to_lowercase();
                let project = if cwd.is_empty() || cwd_l.starts_with("c:\\windows") || cwd_l.starts_with("c:\\program files") || cwd_l.ends_with("\\system32\\") {
                    String::new()
                } else {
                    folder_name(&cwd)
                };
                let kind = guess_kind(&name, &cmd, port).to_string();
                Port {
                    port,
                    addr,
                    pid,
                    dev: !system && !kind.is_empty(),
                    kind,
                    name,
                    project,
                    cwd,
                    cmd: truncate(&cmd, 180),
                    system,
                }
            })
            .collect();
        // Docker aynı portu iki süreçle dinler (backend ve wslrelay); birini göster.
        out.sort_by_key(|p| (p.port, p.name.to_lowercase().contains("wslrelay")));
        out.dedup_by_key(|p| p.port);
        out.sort_by_key(|p| (p.system, !p.dev, p.port));
        out
    }

    /// Son çağrıdan bu yana alınan ve gönderilen bayt (sanal ve geri döngü arayüzleri hariç).
    pub fn net(&self) -> (u64, u64) {
        let mut nets = self.nets.lock().unwrap();
        nets.refresh(true);
        nets.list()
            .iter()
            .filter(|(name, _)| {
                let n = name.to_lowercase();
                !(n.contains("loopback") || n.contains("vethernet") || n.contains("virtual") || n.contains("wsl"))
            })
            .fold((0, 0), |(r, t), (_, d)| (r + d.received(), t + d.transmitted()))
    }

    /// CPU (%), bellek (bayt).
    pub fn usage(&self) -> (f32, u64, u64) {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (sys.global_cpu_usage(), sys.used_memory(), sys.total_memory())
    }

    /// En çok bellek kullanan süreçler (aynı adlılar toplanır).
    pub fn top(&self) -> Vec<(String, u64, usize)> {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
        let mut by: HashMap<String, (u64, usize)> = HashMap::new();
        for p in sys.processes().values() {
            let e = by.entry(p.name().to_string_lossy().into_owned()).or_default();
            e.0 += p.memory();
            e.1 += 1;
        }
        let mut v: Vec<(String, u64, usize)> = by.into_iter().map(|(n, (m, c))| (n, m, c)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v.truncate(8);
        v
    }
}

// ---------- Docker ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
    pub project: String,
}

/// Çalışan container'lar. Docker kurulu değilse ya da çalışmıyorsa None.
pub fn docker() -> Option<Vec<Container>> {
    let out = run(
        "docker",
        &["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.Label \"com.docker.compose.project\"}}"],
    )?;
    Some(
        out.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                let g = |i: usize| f.get(i).copied().unwrap_or("").to_string();
                Container { name: g(0), image: g(1), status: g(2), ports: g(3), project: g(4) }
            })
            .collect(),
    )
}

// ---------- Git ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub changes: u32,
}

pub fn git(dirs: &[String]) -> Vec<Repo> {
    let mut seen = HashSet::new();
    dirs.iter()
        .filter(|d| seen.insert(crate::store::norm_path(d)))
        .filter_map(|d| {
            let out = run("git", &["-C", d, "status", "--porcelain=v1", "-b"])?;
            let mut lines = out.lines();
            let head = lines.next().unwrap_or("").trim_start_matches("## ");
            let branch = head.split("...").next().unwrap_or(head).split(' ').next().unwrap_or("").to_string();
            let num = |key: &str| {
                head.split(key).nth(1).and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next()).and_then(|n| n.parse().ok()).unwrap_or(0)
            };
            Some(Repo {
                path: d.clone(),
                name: folder_name(d),
                branch,
                ahead: num("ahead "),
                behind: num("behind "),
                changes: lines.filter(|l| !l.trim().is_empty()).count() as u32,
            })
        })
        .collect()
}

// ---------- Aç / kapat ----------

pub fn kill(pid: u32) -> Result<(), String> {
    run("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]).map(|_| ()).ok_or_else(|| "Süreç kapatılamadı (yetki gerekebilir)".into())
}

pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Geçersiz adres".into());
    }
    launch("cmd", &["/c", "start", "", url])
}

/// `kind`: code | terminal | folder
pub fn open_path(kind: &str, path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).is_dir() {
        return Err(format!("Klasör yok: {path}"));
    }
    match kind {
        "code" => launch("cmd", &["/c", "code", path]),
        "terminal" => launch("wt", &["-d", path]).or_else(|_| launch("cmd", &["/c", "start", "", "cmd", "/k", "cd", "/d", path])),
        "folder" => launch("explorer", &[path]),
        _ => Err("Bilinmeyen".into()),
    }
}

// ---------- Bar için özet ----------

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Geliştirme araçlarının dinlediği port sayısı.
    pub ports: usize,
    /// Çalışan container sayısı; Docker yoksa None.
    pub docker: Option<usize>,
    /// Değişikliği olan repo sayısı (son projeler arasında).
    pub git: usize,
    /// Saniyedeki indirme ve yükleme (bayt).
    pub net_rx: u64,
    pub net_tx: u64,
    /// Bilgisayarın yerel ağ adresi.
    pub ip: Option<String>,
    /// Telefon erişimi açık mı.
    pub phone: bool,
}

/// Bar göstergeleri için arka planda periyodik özet yayınlar.
pub fn start(app: AppHandle, st: Shared) {
    std::thread::spawn(move || {
        let mut sum = Summary::default();
        let mut tick: u64 = 0;
        let mut last = std::time::Instant::now();
        st.mon.net();
        loop {
            let (rx, tx) = st.mon.net();
            let secs = last.elapsed().as_secs_f64().max(0.5);
            last = std::time::Instant::now();
            sum.net_rx = (rx as f64 / secs) as u64;
            sum.net_tx = (tx as f64 / secs) as u64;
            sum.phone = st.settings.lock().unwrap().remote;
            if tick % 10 == 0 {
                sum.ip = crate::remote::lan_ip();
            }
            let (cpu, used, total) = st.mon.usage();
            sum.cpu = cpu;
            sum.mem_used = used;
            sum.mem_total = total;
            if tick % 2 == 0 {
                sum.ports = st.mon.ports().iter().filter(|p| p.dev).count();
            }
            // Hızlı olanlar hemen gitsin; Docker ve git (yavaş) gelince ayrıca yayınlanır.
            let _ = app.emit("sys", sum.clone());
            if tick % 10 == 0 {
                sum.docker = docker().map(|c| c.len());
                let _ = app.emit("sys", sum.clone());
            }
            if tick % 20 == 0 {
                sum.git = git(&project_dirs(&st)).iter().filter(|r| r.changes > 0 || r.ahead > 0).count();
                let _ = app.emit("sys", sum.clone());
            }
            tick += 1;
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}

/// Git'e bakılacak klasörler: son kullanılanlar, açık sekmeler ve bunların üst klasörlerindeki
/// repolar (iki seviye: `C:\dev` altında `ciworks\proje` gibi). En fazla 60.
pub fn project_dirs(st: &Shared) -> Vec<String> {
    let (recent, def) = {
        let s = st.settings.lock().unwrap();
        (s.recent.clone(), s.cwd.clone())
    };
    let mut dirs: Vec<String> = recent;
    dirs.extend(st.tabs.lock().unwrap().iter().map(|t| t.cwd.clone()));
    dirs.push(def);
    let is_repo = |p: &std::path::Path| p.join(".git").exists();
    let skip = |name: &str| name.starts_with('.') || name.starts_with('_') || name == "node_modules";
    // Kökler: bilinen klasörlerin üstleri. Sürücü kökü ve kullanıcı klasörünün üstü (C:\Users) atlanır.
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let users = std::path::Path::new(&home).parent().map(|p| p.to_path_buf());
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for d in &dirs {
        if let Some(r) = std::path::Path::new(d).parent() {
            let r = r.to_path_buf();
            if r.parent().is_some() && Some(&r) != users.as_ref() && !roots.contains(&r) {
                roots.push(r);
            }
        }
    }
    for root in roots.iter().take(4) {
        for a in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let pa = a.path();
            if !pa.is_dir() || skip(&a.file_name().to_string_lossy()) {
                continue;
            }
            if is_repo(&pa) {
                dirs.push(pa.to_string_lossy().into_owned());
                continue;
            }
            for b in std::fs::read_dir(&pa).into_iter().flatten().flatten() {
                let pb = b.path();
                if pb.is_dir() && !skip(&b.file_name().to_string_lossy()) && is_repo(&pb) {
                    dirs.push(pb.to_string_lossy().into_owned());
                }
            }
        }
    }
    dirs.truncate(60);
    dirs
}
