// Telefon erişimi: Ada'nın PWA'sını ve token korumalı küçük bir API'yi LAN üzerinden sunar.
//
// Sunucunun yaşam döngüsü: ayar açılınca 0.0.0.0:47822'de tiny_http sunucusu kurulur.
// Kapatılınca önce `unblock` ile bizim kabul döngümüz durdurulur, sunucu bırakılır, sonra
// tiny_http'nin kendi accept thread'i 127.0.0.1'e kısa bir bağlantıyla uyandırılır. (tiny_http
// bunu kendisi dinlediği adrese bağlanarak yapıyor; 0.0.0.0'a bağlanmak Windows'ta olmuyor.)
// Böylece port gerçekten kapanır ve tekrar açılabilir. `ADA_REMOTE_HOST` ortam değişkeniyle
// başka bir adres verilebilir (ör. Tailscale serve kullanırken sadece 127.0.0.1).
//
// Canlı akış (SSE): her telefon için sınırlı bir kanal açılır. Olaylar Hub üzerinden kanallara
// yazılır; isteğin kendi thread'i kanaldan okuyup chunked olarak sokete yazar. Kanal dolarsa
// (yavaş bağlantı) ya da soket kapanırsa istemci düşürülür; telefon yeniden bağlanınca güncel
// durumu ve ekranı baştan alır. Terminal çıktısı sadece `?tabs=` ile abone olunan sekmeler için
// gider, böylece listeye bakan telefon boşuna veri çekmez.
//
// Kilit sırası: Hub kilidi en dışta. Hub'a çağrı yaparken agents/tabs/settings/ptys kilitleri
// tutulmaz; abone olurken anlık durum Hub kilidi altında alınır ki arada olay kaçmasın.

use crate::hooks::Agent;
use crate::store::Tab;
use crate::Shared;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpStream, UdpSocket};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::AppHandle;
use tiny_http::{Header, Method, Request, Response};

pub const PORT: u16 = 47822;
/// Sekme başına saklanan son terminal çıktısı; geç bağlanan telefon ekranı buradan kurar.
const SCREEN_MAX: usize = 64 * 1024;
/// GitHub Pages'teki PWA kopyası (Tailscale gibi bir HTTPS adresi üzerinden bağlanır).
const PAGES_ORIGIN: &str = "https://alperkosay.github.io";
/// İstemci başına bekleyen olay sınırı; dolarsa istemci düşürülür ve yeniden bağlanır.
const QUEUE: usize = 1024;
const BODY_MAX: u64 = 1 << 20;

struct Screen {
    data: String,
    cols: u16,
    rows: u16,
}

struct Client {
    tx: SyncSender<String>,
    tabs: HashSet<String>,
}

#[derive(Default)]
struct Inner {
    clients: Vec<Client>,
    screens: HashMap<String, Screen>,
}

/// Telefonlara giden olayların dağıtıcısı ve sekmelerin ekran tamponu.
#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
    server: Mutex<Option<(Arc<tiny_http::Server>, JoinHandle<()>)>>,
}

fn sse<T: Serialize + ?Sized>(event: &str, payload: &T) -> String {
    let data = serde_json::to_string(payload).unwrap_or_else(|_| "null".into());
    format!("event: {event}\ndata: {data}\n\n")
}

/// Tamponu sondan SCREEN_MAX bayta indirir. Kaçış dizisinin ortasından başlamamak için
/// mümkünse bir satır sonundan keser.
fn trim(s: &mut String) {
    let mut cut = s.len() - SCREEN_MAX;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    if let Some(nl) = s[cut..].find('\n') {
        if nl < 4096 {
            cut += nl + 1;
        }
    }
    s.drain(..cut);
}

impl Hub {
    /// Bağlı tüm telefonlara bir olay yollar.
    pub fn send<T: Serialize + ?Sized>(&self, event: &str, payload: &T) {
        let mut inner = self.inner.lock().unwrap();
        if inner.clients.is_empty() {
            return;
        }
        let msg = sse(event, payload);
        inner.clients.retain(|c| c.tx.try_send(msg.clone()).is_ok());
    }

    /// Sekmenin terminal çıktısını tampona ekler ve o sekmeye abone telefonlara yollar.
    pub fn pty(&self, id: &str, data: &str) {
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let s = inner.screens.entry(id.to_string()).or_insert_with(|| Screen { data: String::new(), cols: 0, rows: 0 });
        s.data.push_str(data);
        if s.data.len() > SCREEN_MAX + SCREEN_MAX / 4 {
            trim(&mut s.data);
        }
        if inner.clients.iter().any(|c| c.tabs.contains(id)) {
            let msg = sse("pty", &json!({ "id": id, "data": data }));
            inner.clients.retain(|c| !c.tabs.contains(id) || c.tx.try_send(msg.clone()).is_ok());
        }
    }

    /// Masaüstündeki terminal boyutu değişti; telefon da aynı boyutta çizer.
    pub fn size(&self, id: &str, cols: u16, rows: u16) {
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let s = inner.screens.entry(id.to_string()).or_insert_with(|| Screen { data: String::new(), cols: 0, rows: 0 });
        if (s.cols, s.rows) == (cols, rows) {
            return;
        }
        (s.cols, s.rows) = (cols, rows);
        let msg = sse("size", &json!({ "id": id, "cols": cols, "rows": rows }));
        inner.clients.retain(|c| !c.tabs.contains(id) || c.tx.try_send(msg.clone()).is_ok());
    }

    /// Kapanan sekmenin tamponunu bırakır.
    pub fn forget(&self, id: &str) {
        self.inner.lock().unwrap().screens.remove(id);
    }

    pub fn screen(&self, id: &str) -> Option<Value> {
        let inner = self.inner.lock().unwrap();
        inner.screens.get(id).map(|s| json!({ "id": id, "data": s.data, "cols": s.cols, "rows": s.rows }))
    }

    /// Yeni bir telefonu kaydeder. İlk mesajlar (anlık durum, abone olunan sekmelerin ekranı)
    /// kayıtla aynı kilit altında hazırlanır.
    fn subscribe(&self, tabs: HashSet<String>, hello: impl FnOnce() -> String) -> Receiver<String> {
        let (tx, rx) = sync_channel(QUEUE);
        let mut inner = self.inner.lock().unwrap();
        let _ = tx.try_send(hello());
        for id in &tabs {
            if let Some(s) = inner.screens.get(id) {
                let _ = tx.try_send(sse("screen", &json!({ "id": id, "data": s.data, "cols": s.cols, "rows": s.rows })));
            }
        }
        inner.clients.push(Client { tx, tabs });
        rx
    }

    /// Tüm canlı akışları kapatır (erişim kapatıldı ya da token yenilendi).
    pub fn disconnect_all(&self) {
        self.inner.lock().unwrap().clients.clear();
    }

    pub fn running(&self) -> bool {
        self.server.lock().unwrap().is_some()
    }
}

// ---------- Ayar ve yaşam döngüsü ----------

/// 32 rastgele bayt yerine iki UUID v4: 244 bit rastgelelik, 64 hex karakter.
pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Bilgisayarın yerel ağdaki IPv4 adresi. UDP soketi "bağlanınca" işletim sistemi çıkış
/// arayüzünü seçer; paket gönderilmez.
pub fn lan_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// Ayar açık mı.
    pub on: bool,
    /// Sunucu gerçekten dinliyor mu (port açılamadıysa false).
    pub running: bool,
    pub ip: Option<String>,
    pub port: u16,
    /// Telefonun QR ile açacağı adres (token dahil).
    pub url: Option<String>,
    pub token: String,
}

pub fn info(st: &Shared) -> Info {
    let (on, token) = {
        let s = st.settings.lock().unwrap();
        (s.remote, s.remote_token.clone())
    };
    let ip = lan_ip();
    Info {
        on,
        running: st.hub.running(),
        url: ip.as_ref().map(|ip| format!("http://{ip}:{PORT}/#token={token}")),
        ip,
        port: PORT,
        token,
    }
}

/// Ayara göre sunucuyu başlatır ya da durdurur.
pub fn apply(app: &AppHandle, st: &Shared) -> Result<(), String> {
    let want = st.settings.lock().unwrap().remote;
    let mut slot = st.hub.server.lock().unwrap();
    if want && slot.is_none() {
        let host = std::env::var("ADA_REMOTE_HOST").unwrap_or_else(|_| "0.0.0.0".into());
        let (app, st2) = (app.clone(), st.clone());
        *slot = Some(listen(&host, PORT, move |req| handle(&app, &st2, req))?);
    } else if !want {
        if let Some((server, accept)) = slot.take() {
            close(server, accept, PORT);
        }
        drop(slot);
        st.hub.disconnect_all();
    }
    Ok(())
}

type Running = (Arc<tiny_http::Server>, JoinHandle<()>);

fn listen(host: &str, port: u16, on_request: impl Fn(Request) + Clone + Send + 'static) -> Result<Running, String> {
    let server = tiny_http::Server::http((host, port)).map_err(|e| format!("Port {port} açılamadı: {e}"))?;
    let server = Arc::new(server);
    let srv = server.clone();
    let accept = std::thread::spawn(move || {
        for req in srv.incoming_requests() {
            let f = on_request.clone();
            // Her istek kendi thread'inde: canlı akışlar diğer istekleri bekletmesin.
            std::thread::spawn(move || f(req));
        }
    });
    Ok((server, accept))
}

fn close(server: Arc<tiny_http::Server>, accept: JoinHandle<()>, port: u16) {
    server.unblock();
    let _ = accept.join();
    drop(server); // son referans: tiny_http kapanma bayrağını kurar
    let _ = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_millis(300));
}

// ---------- İstekler ----------

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("geçerli başlık")
}

fn req_header(req: &Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
}

/// Sabit sürede karşılaştırma: token tahmini için zamanlama ipucu vermesin.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let decoded = match b[i] {
            b'%' if i + 2 < b.len() => hex(b[i + 1]).zip(hex(b[i + 2])).map(|(h, l)| h * 16 + l),
            _ => None,
        };
        match decoded {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(if b[i] == b'+' { b' ' } else { b[i] });
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| percent_decode(v))
}

fn authorized(st: &Shared, req: &Request, query: &str) -> bool {
    let token = st.settings.lock().unwrap().remote_token.clone();
    if token.is_empty() {
        return false;
    }
    let given = req_header(req, "Authorization")
        .and_then(|h| h.strip_prefix("Bearer ").map(|t| t.trim().to_string()))
        .or_else(|| param(query, "token"))
        .unwrap_or_default();
    ct_eq(given.as_bytes(), token.as_bytes())
}

fn reply(req: Request, status: u16, ctype: &str, body: Vec<u8>, cors: Option<&str>, cache: &str) {
    let mut r = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", ctype))
        .with_header(header("Cache-Control", cache));
    if let Some(o) = cors {
        r.add_header(header("Access-Control-Allow-Origin", o));
        r.add_header(header("Vary", "Origin"));
    }
    let _ = req.respond(r);
}

fn json_reply<T: Serialize + ?Sized>(req: Request, status: u16, v: &T, cors: Option<&str>) {
    let body = serde_json::to_vec(v).unwrap_or_default();
    reply(req, status, "application/json; charset=utf-8", body, cors, "no-store");
}

fn error(req: Request, status: u16, msg: &str, cors: Option<&str>) {
    json_reply(req, status, &json!({ "error": msg }), cors);
}

fn read_json(req: &mut Request) -> Value {
    let mut body = String::new();
    let _ = req.as_reader().take(BODY_MAX).read_to_string(&mut body);
    serde_json::from_str(&body).unwrap_or(Value::Null)
}

fn handle(app: &AppHandle, st: &Shared, mut req: Request) {
    // Aynı kaynaktan (Ada'nın kendi sunduğu PWA) gelen isteklerde CORS gerekmez;
    // izin verilen tek dış kaynak GitHub Pages kopyası.
    let cors = req_header(&req, "Origin").filter(|o| o == PAGES_ORIGIN);
    let cors = cors.as_deref();
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let method = req.method().clone();

    if method == Method::Options {
        let mut r = Response::empty(204)
            .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "Authorization, Content-Type"))
            .with_header(header("Access-Control-Max-Age", "600"));
        if let Some(o) = cors {
            r.add_header(header("Access-Control-Allow-Origin", o));
            r.add_header(header("Vary", "Origin"));
            if req_header(&req, "Access-Control-Request-Private-Network").is_some() {
                r.add_header(header("Access-Control-Allow-Private-Network", "true"));
            }
        }
        let _ = req.respond(r);
        return;
    }

    if !path.starts_with("/api/") {
        return serve_static(req, path, &method);
    }
    if !authorized(st, &req, query) {
        return error(req, 401, "Token geçersiz", cors);
    }

    let parts: Vec<&str> = path.trim_start_matches("/api/").trim_end_matches('/').split('/').collect();
    match (&method, parts.as_slice()) {
        (Method::Get, ["state"]) => json_reply(req, 200, &snapshot(st), cors),
        (Method::Get, ["events"]) => events(st, req, query, cors),
        (Method::Get, ["tabs", id, "buffer"]) => match st.hub.screen(id) {
            Some(s) => json_reply(req, 200, &s, cors),
            None => error(req, 404, "Bu sekmenin çıktısı yok", cors),
        },
        (Method::Post, ["tabs", id, "input"]) => {
            let id = id.to_string();
            let body = read_json(&mut req);
            let Some(data) = body["data"].as_str() else {
                return error(req, 400, "data alanı gerekli", cors);
            };
            if crate::pty::write(st, &id, data) {
                json_reply(req, 200, &json!({ "ok": true }), cors);
            } else {
                error(req, 409, "Oturum kapalı", cors);
            }
        }
        (Method::Post, ["tabs", id, "start"]) => {
            let id = id.to_string();
            let (cols, rows) = *st.term_size.lock().unwrap();
            match crate::start_tab(app, st, &id, cols, rows) {
                Ok(tab) => json_reply(req, 200, &tab, cors),
                Err(e) => error(req, 400, &e, cors),
            }
        }
        (Method::Post, ["tabs"]) => {
            let body = read_json(&mut req);
            if !body.is_object() {
                return error(req, 400, "Geçersiz JSON", cors);
            }
            let cwd = body["cwd"].as_str().map(String::from);
            let (cols, rows) = *st.term_size.lock().unwrap();
            let res = crate::create_tab(app, st, cwd).and_then(|t| crate::start_tab(app, st, &t.id, cols, rows));
            match res {
                Ok(tab) => json_reply(req, 200, &tab, cors),
                Err(e) => error(req, 400, &e, cors),
            }
        }
        _ => error(req, 404, "Bulunamadı", cors),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneState {
    agents: Vec<Agent>,
    tabs: Vec<Tab>,
    recent: Vec<String>,
    default_cwd: String,
}

fn snapshot(st: &Shared) -> PhoneState {
    let agents = st.agents.lock().unwrap().values().cloned().collect();
    let tabs = st.tabs.lock().unwrap().clone();
    let (recent, default_cwd) = {
        let s = st.settings.lock().unwrap();
        (s.recent.clone(), s.cwd.clone())
    };
    PhoneState { agents, tabs, recent, default_cwd }
}

fn chunk(w: &mut dyn Write, data: &[u8]) -> std::io::Result<()> {
    write!(w, "{:x}\r\n", data.len())?;
    w.write_all(data)?;
    w.write_all(b"\r\n")?;
    w.flush()
}

/// Server-Sent Events: tiny_http'nin kendi chunked kodlayıcısı 8 KB dolana kadar tamponladığı
/// için yanıtı soket üzerine elle yazıyoruz; her olay grubu ayrı bir chunk olarak hemen gider.
fn events(st: &Shared, req: Request, query: &str, cors: Option<&str>) {
    let tabs: HashSet<String> = param(query, "tabs")
        .map(|t| t.split(',').filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    let rx = st.hub.subscribe(tabs, || sse("state", &snapshot(st)));
    let mut w = req.into_writer();
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nX-Accel-Buffering: no\r\nTransfer-Encoding: chunked\r\n",
    );
    if let Some(o) = cors {
        head.push_str(&format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n"));
    }
    head.push_str("\r\n");
    if w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_err() {
        return;
    }
    let mut batch = String::from("retry: 3000\n\n");
    loop {
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(m) => {
                batch.push_str(&m);
                while batch.len() < 256 * 1024 {
                    match rx.try_recv() {
                        Ok(m) => batch.push_str(&m),
                        Err(_) => break,
                    }
                }
            }
            // Ölü bağlantıyı fark etmek ve aradaki proxy'leri uyanık tutmak için.
            Err(RecvTimeoutError::Timeout) => batch.push_str(": ping\n\n"),
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if chunk(&mut *w, batch.as_bytes()).is_err() {
            return;
        }
        batch.clear();
    }
    let _ = w.write_all(b"0\r\n\r\n");
    let _ = w.flush();
}

// ---------- PWA dosyaları (derlemeye gömülü, exe tek başına yeter) ----------

macro_rules! asset {
    ($path:literal, $ctype:expr) => {
        (concat!("/", $path), include_bytes!(concat!("../../mobile/", $path)) as &[u8], $ctype)
    };
}

const JS: &str = "text/javascript; charset=utf-8";
static ASSETS: &[(&str, &[u8], &str)] = &[
    asset!("index.html", "text/html; charset=utf-8"),
    asset!("app.js", JS),
    asset!("icons.js", JS),
    asset!("style.css", "text/css; charset=utf-8"),
    asset!("manifest.webmanifest", "application/manifest+json"),
    asset!("sw.js", JS),
    asset!("icons/icon-192.png", "image/png"),
    asset!("icons/icon-512.png", "image/png"),
    asset!("icons/apple-touch-icon.png", "image/png"),
    asset!("vendor/xterm.js", JS),
    asset!("vendor/xterm.css", "text/css; charset=utf-8"),
    asset!("fonts/inter-latin-wght-normal.woff2", "font/woff2"),
    asset!("fonts/inter-latin-ext-wght-normal.woff2", "font/woff2"),
];

fn serve_static(req: Request, path: &str, method: &Method) {
    if *method != Method::Get && *method != Method::Head {
        return reply(req, 405, "text/plain; charset=utf-8", b"Yalnizca GET".to_vec(), None, "no-store");
    }
    let path = if path == "/" { "/index.html" } else { path };
    match ASSETS.iter().find(|(p, _, _)| *p == path) {
        // no-cache: telefon her açılışta sürümü doğrular, Ada güncellenince PWA da güncellenir.
        Some((_, body, ctype)) => reply(req, 200, ctype, body.to_vec(), None, "no-cache"),
        None => reply(req, 404, "text/plain; charset=utf-8", b"Bulunamadi".to_vec(), None, "no-store"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert_eq!(new_token().len(), 64);
    }

    #[test]
    fn query_params() {
        assert_eq!(param("token=ab&tabs=x%2Cy", "tabs").as_deref(), Some("x,y"));
        assert_eq!(param("token=ab", "tabs"), None);
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    /// Kapatılan sunucunun portu gerçekten bırakması ve aynı porta yeniden açılabilmesi.
    /// (Testte 0.0.0.0 yerine 127.0.0.1: güvenlik duvarı sormasın.)
    #[test]
    fn restart_same_port() {
        let port = 47899;
        let ok = |req: Request| {
            let _ = req.respond(Response::from_string("ok"));
        };
        for _ in 0..3 {
            let (srv, accept) = listen("127.0.0.1", port, ok).expect("port açılmalı");
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            assert!(out.ends_with("ok"), "{out}");
            close(srv, accept, port);
            std::thread::sleep(Duration::from_millis(100));
            assert!(TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_millis(300)).is_err());
        }
    }

    #[test]
    fn screen_trim() {
        let mut s = "x".repeat(SCREEN_MAX + 100) + "\nson";
        trim(&mut s);
        assert!(s.len() <= SCREEN_MAX);
        assert!(s.ends_with("son"));
    }
}
