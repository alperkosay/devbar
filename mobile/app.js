// DevBar telefon arayüzü: tüm Claude oturumlarını canlı izler, DevBar sekmelerine yazar, yeni oturum açar.
// DevBar'ın kendisi sunuyorsa (evde, http://<bilgisayar>:47822) API aynı adreste. GitHub Pages'ten
// açıldıysa sunucu adresi ve token Bağlantı ekranından (ya da #server=...&token=... ile) gelir.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const folderName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'şimdi';
  if (s < 3600) return `${Math.floor(s / 60)} dk`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa`;
  return `${Math.floor(s / 86400)} g`;
};
const buzz = () => navigator.vibrate?.(8);
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null || v === '') localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

// ---------- Durum ----------
const S = {
  agents: new Map(), // sessionId -> agent
  tabs: new Map(), // sekme id -> tab
  recent: [],
  defaultCwd: '',
  loaded: false,
  screen: 'list', // list | new | conn
  tab: null, // açık sekme id
};

// Bağlantı: base boşsa aynı adres (DevBar'ın kendisi sunuyor).
const C = {
  base: '',
  token: '',
  status: 'connecting', // connecting | online | offline | auth | setup
  es: null,
  retry: 0,
  timer: null,
  error: '',
};
const ON_PAGES = location.hostname.endsWith('github.io');

function normBase(s) {
  s = (s || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function loadConfig() {
  C.base = normBase(store.get('ada.server') || '');
  C.token = store.get('ada.token') || '';
  // QR ya da paylaşılan link: #token=...&server=... Kaydet ve adres çubuğundan sil.
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has('token') || h.has('server')) {
    if (h.has('server')) C.base = normBase(h.get('server'));
    if (h.has('token')) C.token = h.get('token').trim();
    store.set('ada.server', C.base);
    store.set('ada.token', C.token);
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function serverLabel() {
  return (C.base || location.origin).replace(/^https?:\/\//, '');
}

// ---------- API ----------
async function api(path, body) {
  const opts = { headers: { Authorization: 'Bearer ' + C.token } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(C.base + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Hata ${res.status}`), { status: res.status });
  return data;
}

// ---------- Canlı akış (SSE) ----------
function setStatus(s, error = '') {
  C.status = s;
  C.error = error;
  render();
}

function disconnect() {
  clearTimeout(C.timer);
  if (C.es) {
    C.es.onerror = null;
    C.es.close();
    C.es = null;
  }
}

function connect() {
  disconnect();
  if (!C.token || (ON_PAGES && !C.base)) return setStatus('setup');
  if (location.protocol === 'https:' && C.base.startsWith('http://')) {
    return setStatus('setup', 'HTTPS sayfa http adrese bağlanamaz. Tailscale gibi bir HTTPS adresi kullan ya da evde DevBar\'ın kendi adresini aç.');
  }
  if (C.status !== 'online') setStatus('connecting');
  let url = `${C.base}/api/events?token=${encodeURIComponent(C.token)}`;
  // Terminal çıktısı sadece açık sekme için gelir.
  if (S.tab) url += `&tabs=${encodeURIComponent(S.tab)}`;
  if (S.tab) showOverlay('loading');
  const es = new EventSource(url);
  C.es = es;
  es.onopen = () => {
    C.retry = 0;
    setStatus('online');
  };
  es.onerror = () => {
    disconnect();
    probe();
  };
  const on = (name, fn) =>
    es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.error(name, err);
      }
    });
  on('state', onState);
  on('agent', (a) => {
    if (a.status === 'ended') S.agents.delete(a.sessionId);
    else S.agents.set(a.sessionId, a);
    render();
  });
  on('agent-remove', (id) => {
    S.agents.delete(id);
    render();
  });
  on('tab', (t) => {
    S.tabs.set(t.id, t);
    render();
  });
  on('tab-remove', (id) => {
    S.tabs.delete(id);
    if (S.tab === id) {
      toast('Sekme bilgisayarda kapatıldı');
      closeTab();
    } else render();
  });
  on('screen', (s) => {
    if (s.id !== S.tab) return;
    term.reset();
    if (s.cols && s.rows) term.resize(s.cols, s.rows);
    term.write(s.data, () => term.scrollToBottom());
    hideOverlay();
    renderTabHead();
  });
  on('pty', (p) => {
    if (p.id === S.tab) term.write(p.data);
  });
  on('size', (s) => {
    if (s.id === S.tab && s.cols && s.rows) term.resize(s.cols, s.rows);
  });
}

// Akış koptu: token mı geçersiz, bilgisayar mı ulaşılmaz? Sonra artan aralıklarla yeniden dene.
async function probe() {
  try {
    await api('/api/state');
  } catch (e) {
    if (e.status === 401) return setStatus('auth', 'Token geçersiz. Bilgisayardaki DevBar\'da QR\'ı yeniden okut.');
    setStatus('offline');
  }
  const wait = Math.min(15000, 1000 * 2 ** C.retry) * (0.8 + Math.random() * 0.4);
  C.retry = Math.min(C.retry + 1, 5);
  C.timer = setTimeout(connect, wait);
}

function onState(st) {
  S.agents = new Map(st.agents.filter((a) => a.status !== 'ended').map((a) => [a.sessionId, a]));
  S.tabs = new Map(st.tabs.map((t) => [t.id, t]));
  S.recent = st.recent || [];
  S.defaultCwd = st.defaultCwd || '';
  S.loaded = true;
  if (S.tab && !S.tabs.has(S.tab)) {
    toast('Sekme artık yok');
    return closeTab();
  }
  if (S.tab && !S.tabs.get(S.tab).alive) {
    // Kapalı sekmenin bu DevBar açılışında çıktısı olmayabilir; ekran gelmezse "devam et" göster.
    setTimeout(() => {
      if (S.tab && $('tv-over').dataset.kind === 'loading') showOverlay('closed');
    }, 600);
  }
  render();
}

// Telefon arka plana gidince tarayıcı bağlantıyı kesebilir; öne gelince hemen bağlan.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && C.status !== 'online' && C.status !== 'setup') {
    C.retry = 0;
    connect();
  }
});
window.addEventListener('online', () => {
  C.retry = 0;
  connect();
});

// ---------- Oturum listesi ----------
const PRI = { waiting: 4, running: 3, done: 2, idle: 1, off: 0 };
const LABEL = { running: 'Çalışıyor', waiting: 'Seni bekliyor', done: 'Bitti', idle: 'Hazır', off: 'Kapalı' };

// Hook'tan gelen oturumlar ve henüz oturumu görünmeyen DevBar sekmeleri, tek liste.
function items() {
  const cut = Date.now() - 6 * 3600e3;
  const list = [];
  const linked = new Set();
  for (const a of S.agents.values()) {
    if (a.tab) linked.add(a.tab);
    if (a.updated < cut && a.status !== 'running' && a.status !== 'waiting') continue;
    list.push({
      key: a.sessionId,
      tab: a.tab && S.tabs.has(a.tab) ? a.tab : null,
      status: a.status,
      project: a.project || folderName(a.cwd),
      activity: a.activity,
      prompt: a.prompt,
      updated: a.updated,
    });
  }
  for (const t of S.tabs.values()) {
    if (linked.has(t.id)) continue;
    list.push({
      key: t.id,
      tab: t.id,
      status: t.alive ? 'idle' : 'off',
      project: folderName(t.cwd),
      activity: t.alive ? 'Hazır' : 'Kapalı · dokun, devam et',
      prompt: '',
      updated: t.started || 0,
    });
  }
  return list.sort((a, b) => (PRI[b.status] || 0) - (PRI[a.status] || 0) || b.updated - a.updated);
}

function connPill() {
  const t = { online: 'Bağlı', connecting: 'Bağlanıyor', offline: 'Bağlantı yok', auth: 'Token geçersiz', setup: 'Kurulum' }[C.status];
  return `<button class="conn ${C.status}" data-go="conn"><i></i>${t}</button>`;
}

function card(it, i) {
  const badge = it.tab ? '<span class="src ada">DevBar</span>' : '<span class="src">Terminal</span>';
  const time = it.updated ? `<span class="time">${ago(it.updated)}</span>` : '';
  const prompt = it.prompt ? `<div class="pr">${esc(it.prompt)}</div>` : '';
  const go = it.tab ? `<span class="go">${I.right}</span>` : '';
  return `<button class="card ${it.status}" style="animation-delay:${Math.min(i, 8) * 30}ms" ${it.tab ? `data-tab="${esc(it.tab)}"` : 'data-ext="1"'}>
    <span class="dot ${it.status}"></span>
    <span class="cb">
      <span class="ct"><b>${esc(it.project)}</b>${badge}${time}</span>
      <span class="act">${esc(it.activity || LABEL[it.status] || '')}</span>
      ${prompt}
    </span>${go}</button>`;
}

function listHtml() {
  const list = items();
  const waiting = list.filter((x) => x.status === 'waiting');
  const rest = list.filter((x) => x.status !== 'waiting');
  const sub = !S.loaded
    ? serverLabel()
    : list.length
      ? `${list.length} oturum${waiting.length ? ` · <b>${waiting.length} seni bekliyor</b>` : ''}`
      : 'Hiç oturum yok';
  const head = `<div class="head"><span class="brand">${I.spark}</span><span class="ht"><h1>Oturumlar</h1><span class="sub">${sub}</span></span>${connPill()}</div>`;
  if (!S.loaded) return head + offlineHtml();
  if (!list.length) {
    return `${head}<div class="empty"><div class="big">${I.grid}</div><h3>Henüz oturum yok</h3>
      <p>Bilgisayarda açtığın Claude oturumları burada canlı görünür. Buradan da yeni bir oturum başlatabilirsin.</p>
      <button class="primary" data-go="new">${I.plus}<span>Yeni oturum</span></button></div>`;
  }
  let html = head;
  let n = 0;
  if (waiting.length) {
    html += `<div class="group wait">${I.bell}Seni bekliyor</div><div class="cards">${waiting.map((x) => card(x, n++)).join('')}</div>`;
  }
  if (rest.length) {
    html += `<div class="group">${I.grid}${waiting.length ? 'Diğerleri' : 'Tüm oturumlar'}</div><div class="cards">${rest.map((x) => card(x, n++)).join('')}</div>`;
  }
  return html;
}

function offlineHtml() {
  if (C.status === 'connecting') {
    return `<div class="empty"><div class="spinner"></div><p>${esc(serverLabel())} adresine bağlanıyor…</p></div>`;
  }
  const auth = C.status === 'auth';
  const setup = C.status === 'setup';
  const title = setup ? 'DevBar\'a bağlan' : auth ? 'Token geçersiz' : 'Bağlantı yok';
  const text = setup
    ? 'Bilgisayardaki DevBar\'da Ayarlar → Telefon erişimi\'ni aç ve QR kodu telefonun kamerasıyla okut.'
    : auth
      ? 'Token yenilenmiş olabilir. Bilgisayardaki DevBar\'da QR kodu yeniden okut.'
      : `${esc(serverLabel())} adresine ulaşılamıyor. Bilgisayar açık mı, DevBar çalışıyor mu, aynı Wi-Fi'da mısın? Tekrar deniyorum.`;
  return `<div class="empty"><div class="big ${setup ? '' : 'red'}">${setup ? I.link : auth ? I.key : I.wifiOff}</div><h3>${title}</h3><p>${text}</p>
    <button class="ghost" data-go="conn">${I.link}<span>Bağlantı ayarları</span></button></div>`;
}

// ---------- Yeni oturum ----------
function newHtml() {
  const head = `<div class="head"><span class="brand">${I.plus}</span><span class="ht"><h1>Yeni oturum</h1><span class="sub">Bilgisayarda yeni bir Claude sekmesi</span></span>${connPill()}</div>`;
  if (!S.loaded) return head + offlineHtml();
  const seen = new Set();
  const dirs = [S.defaultCwd, ...S.recent].filter((d) => d && !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()));
  if (!dirs.length) return head + `<div class="empty"><div class="big">${I.folder}</div><h3>Klasör yok</h3><p>Bilgisayarda DevBar'dan bir oturum açınca son klasörler burada listelenir.</p></div>`;
  return `${head}<p class="lead">Bir klasör seç. DevBar bilgisayarda o klasörde <b>claude</b> açar, ekranı buraya gelir.</p>
    <div class="cards">${dirs
      .map(
        (d, i) => `<button class="frow" style="animation-delay:${i * 30}ms" data-cwd="${esc(d)}"><span class="fi">${I.folder}</span>
        <span class="ft"><b>${esc(folderName(d))}</b><span>${esc(d)}</span></span>${d === S.defaultCwd ? '<span class="tag">Varsayılan</span>' : ''}</button>`,
      )
      .join('')}</div>`;
}

async function newSession(row) {
  if (row.classList.contains('busy')) return;
  buzz();
  row.classList.add('busy');
  try {
    const tab = await api('/api/tabs', { cwd: row.dataset.cwd });
    S.tabs.set(tab.id, tab);
    openTab(tab.id);
  } catch (e) {
    toast(e.message, true);
  } finally {
    row.classList.remove('busy');
  }
}

// ---------- Bağlantı ----------
function connHtml() {
  const info = {
    online: ['Bağlı', serverLabel(), I.wifi],
    connecting: ['Bağlanıyor…', serverLabel(), I.wifi],
    offline: ['Bağlantı yok', `${serverLabel()} adresine ulaşılamıyor`, I.wifiOff],
    auth: ['Token geçersiz', C.error, I.key],
    setup: ['Kurulum gerekli', C.error || 'Sunucu adresi ve token gir', I.link],
  }[C.status];
  const sameOrigin = !ON_PAGES;
  return `<div class="head"><span class="brand">${I.link}</span><span class="ht"><h1>Bağlantı</h1><span class="sub">Bilgisayardaki DevBar</span></span></div>
    <div class="status ${C.status}"><span class="si">${info[2]}</span><span class="st"><b>${info[0]}</b><span>${esc(info[1])}</span></span></div>
    <form id="connf">
      <div class="field"><label for="f-server">Sunucu adresi</label>
        <input id="f-server" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(C.base)}" placeholder="${sameOrigin ? 'Boş: bu sayfayı sunan DevBar' : 'https://bilgisayarin.tailnet.ts.net'}">
        <small>${sameOrigin ? 'Evde boş bırak. Başka bir adresten bağlanacaksan yaz.' : 'DevBar\'a ulaşan HTTPS adres (ör. Tailscale serve).'}</small></div>
      <div class="field"><label for="f-token">Token</label>
        <input id="f-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(C.token)}" placeholder="QR ile otomatik gelir">
        <small>Bilgisayardaki DevBar → Ayarlar → Telefon erişimi. QR'ı okutunca kendiliğinden dolar.</small></div>
      <div class="btns"><button class="primary" type="submit">${I.check}<span>Kaydet ve bağlan</span></button>
        ${C.token ? `<button class="ghost" type="button" data-act="forget">${I.trash}<span>Unut</span></button>` : ''}</div>
    </form>
    <div class="help"><h4>${I.home}Evde</h4><ol>
      <li>Bilgisayarda DevBar'ı aç: Ayarlar → <b>Telefon erişimi</b>.</li>
      <li>QR kodu telefonun kamerasıyla okut, açılan sayfayı ana ekrana ekle.</li>
      <li>Telefon ve bilgisayar aynı Wi-Fi'da olmalı.</li></ol></div>
    <div class="help"><h4>${I.globe}Dışarıda</h4>
      <p>Bilgisayarda Tailscale varsa <code>tailscale serve --bg 47822</code> ile DevBar'ı tailnet'ine HTTPS olarak aç. Sonra bu uygulamanın GitHub Pages kopyasında sunucu adresine o adresi, token'a QR'daki token'ı yaz.</p></div>`;
}

// ---------- Ana çizim ----------
function render() {
  renderNav();
  if (S.tab) return renderTabHead();
  const main = $('main');
  const top = main.scrollTop;
  if (S.screen === 'conn') {
    // Form doluyken yeniden çizip yazılanı silme; sadece durum kutusunu güncelle.
    const f = $('connf');
    if (f && main.contains(f)) {
      const fresh = document.createElement('div');
      fresh.innerHTML = connHtml();
      main.querySelector('.status').replaceWith(fresh.querySelector('.status'));
      return;
    }
    main.innerHTML = connHtml();
  } else if (S.screen === 'new') main.innerHTML = newHtml();
  else main.innerHTML = listHtml();
  main.scrollTop = top;
}

function renderNav() {
  const waiting = [...S.agents.values()].filter((a) => a.status === 'waiting').length;
  const b = (k, ic, label, extra = '') => `<button class="${S.screen === k ? 'on' : ''}" data-go="${k}">${ic}<span>${label}</span>${extra}</button>`;
  $('nav').innerHTML =
    b('list', I.grid, 'Oturumlar', waiting ? `<span class="badge">${waiting}</span>` : '') + b('new', I.plus, 'Yeni') + b('conn', I.link, 'Bağlantı');
}

function go(screen) {
  if (S.screen === screen) {
    $('main').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  S.screen = screen;
  $('main').scrollTop = 0;
  render();
}

// Liste anlık süreleri tazelensin.
setInterval(() => {
  if (!S.tab && S.screen === 'list' && document.visibilityState === 'visible') render();
}, 30000);

// ---------- Sekme ekranı (terminal) ----------
const XTHEME = {
  background: '#0a0a0c',
  foreground: '#e4e4e7',
  cursor: '#e8835e',
  cursorAccent: '#0a0a0c',
  selectionBackground: 'rgba(232,131,94,0.32)',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#f472b6',
  cyan: '#2dd4bf',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#f9a8d4',
  brightCyan: '#5eead4',
  brightWhite: '#fafafa',
};
const ZOOMS = [8, 9, 10, 11, 12, 13, 14];
let zoom = +store.get('ada.zoom') || 11;

// Terminal masaüstüyle aynı boyutta (sütun × satır) çizilir; telefon boyutlandırmaz, böylece
// bilgisayardaki görüntü bozulmaz. Geniş ekran yatay kaydırılır, yazı boyutu A-/A+ ile değişir.
const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", "Droid Sans Mono", monospace',
  fontSize: zoom,
  lineHeight: 1.12,
  cols: 110,
  rows: 32,
  scrollback: 4000,
  disableStdin: true,
  cursorBlink: false,
  theme: XTHEME,
});
// Terminal ilk sekme açılınca, görünürken kurulur (gizliyken karakter boyutu ölçülemiyor).
let termOpened = false;
function ensureTermOpen() {
  if (termOpened) return;
  termOpened = true;
  term.open($('tv-inner'));
  // Terminale dokununca klavye açılmasın; yazı alttaki kutudan gider.
  if (term.textarea) {
    term.textarea.readOnly = true;
    term.textarea.setAttribute('inputmode', 'none');
    term.textarea.tabIndex = -1;
  }
}

// Yatay kaydırma: xterm dokunmatik hareketi kendi dikey kaydırması için yakalıyor. Hareket
// yataysa xterm'e ulaşmadan biz kaydırıyoruz.
(() => {
  const wrap = $('tv-term');
  let g = null;
  wrap.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      g = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, left: wrap.scrollLeft, dir: null } : null;
    },
    { capture: true, passive: true },
  );
  wrap.addEventListener(
    'touchmove',
    (e) => {
      if (!g || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (!g.dir && Math.hypot(dx, dy) > 8) g.dir = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.dir === 'x') {
        e.stopPropagation();
        e.preventDefault();
        wrap.scrollLeft = g.left - dx;
      }
    },
    { capture: true, passive: false },
  );
})();

function showOverlay(kind) {
  const o = $('tv-over');
  o.dataset.kind = kind;
  const tab = S.tabs.get(S.tab);
  if (kind === 'loading') o.innerHTML = '<div class="box"><div class="spinner"></div><span>Ekran geliyor…</span></div>';
  else if (kind === 'closed')
    o.innerHTML = `<div class="box"><b>Oturum kapalı</b><span>${esc(tab?.cwd || '')}</span>
      <button class="primary" data-act="resume">${I.play}<span>${tab?.used ? 'Kaldığın yerden devam et' : 'Başlat'}</span></button></div>`;
  o.classList.add('on');
}
function hideOverlay() {
  const o = $('tv-over');
  o.dataset.kind = '';
  o.classList.remove('on');
}

function tabAgent(id) {
  return [...S.agents.values()].find((a) => a.tab === id) || null;
}

function renderTabHead() {
  const tab = S.tabs.get(S.tab);
  if (!tab) return;
  const a = tabAgent(tab.id);
  const status = a?.status || (tab.alive ? 'idle' : 'off');
  const activity = a?.activity || (tab.alive ? 'Hazır' : 'Kapalı');
  $('tv-head').innerHTML = `<button class="iconb" data-act="back" aria-label="Geri">${I.back}</button>
    <span class="tt"><b><span class="dot ${status}"></span><span>${esc(folderName(tab.cwd))}</span></b><small class="${status}">${esc(activity)}</small></span>
    <span class="zoom"><button class="iconb small" data-zoom="-1" aria-label="Küçült">A-</button><button class="iconb small" data-zoom="1" aria-label="Büyüt">A+</button></span>`;
  const off = !tab.alive;
  $('input').disabled = off;
  $('send').disabled = off;
  if (off && $('tv-over').dataset.kind !== 'loading') showOverlay('closed');
  else if (!off && $('tv-over').dataset.kind === 'closed') hideOverlay();
}

function openTab(id) {
  S.tab = id;
  $('screens').hidden = true;
  $('tabv').hidden = false;
  ensureTermOpen();
  term.reset();
  $('tv-term').scrollLeft = 0;
  history.pushState({ tab: id }, '');
  renderTabHead();
  C.retry = 0;
  connect(); // bu sekmeye abone olarak yeniden bağlan
}

function closeTab() {
  if (!S.tab) return;
  S.tab = null;
  $('input').blur();
  $('tabv').hidden = true;
  $('screens').hidden = false;
  hideOverlay();
  render();
  C.retry = 0;
  connect(); // terminal akışını bırak
}

window.addEventListener('popstate', () => {
  if (S.tab) closeTab();
});

// ---------- Giriş ----------
const KEYS = [
  ['Esc', '\x1b', 'esc'],
  ['Enter', '\r', 'enter'],
  ['1', '1', 'num'],
  ['2', '2', 'num'],
  ['3', '3', 'num'],
  ['↑', 'up'],
  ['↓', 'down'],
  ['Tab', '\t'],
  ['⇧Tab', '\x1b[Z'],
  ['Ctrl+C', '\x03', 'stop'],
];
$('keys').innerHTML = KEYS.map(([l, , cls], i) => `<button type="button" class="${cls || ''}" data-key="${i}">${l}</button>`).join('');

async function sendRaw(data) {
  if (!S.tab) return;
  try {
    await api(`/api/tabs/${encodeURIComponent(S.tab)}/input`, { data });
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

function keyData(k) {
  // Ok tuşları uygulamanın istediği kipe göre (terminal aynı akışı izlediği için kipi biliyor).
  const app = term.modes?.applicationCursorKeysMode;
  if (k === 'up') return app ? '\x1bOA' : '\x1b[A';
  if (k === 'down') return app ? '\x1bOB' : '\x1b[B';
  return k;
}

$('keys').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (!b) return;
  buzz();
  sendRaw(keyData(KEYS[+b.dataset.key][1])).catch(() => {});
});
// Tuşlara basınca klavye kapanmasın.
$('keys').addEventListener('mousedown', (e) => e.preventDefault());

const input = $('input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}
input.addEventListener('input', autosize);
input.send = async () => {
  const text = input.value;
  if (!text.trim() || !S.tab) return;
  buzz();
  try {
    // Çok satırlı metinde satır sonu Claude Code'da Alt+Enter (yeni satır) olarak gider.
    await sendRaw(text.replace(/\r?\n/g, '\x1b\r'));
    // Metin ve Enter ayrı yazılır; tek parça gelince yapıştırma sanılıp gönderilmeyebiliyor.
    await new Promise((r) => setTimeout(r, 60));
    await sendRaw('\r');
    input.value = '';
    autosize();
  } catch {}
};
$('inbar').addEventListener('submit', (e) => {
  e.preventDefault();
  input.send();
});
input.addEventListener('keydown', (e) => {
  // Donanım klavyesi: Enter gönderir, Shift+Enter yeni satır.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    input.send();
  }
});
$('send').innerHTML = I.up;

// ---------- Tıklamalar ----------
document.addEventListener('click', async (e) => {
  const t = e.target;
  const goBtn = t.closest('[data-go]');
  if (goBtn) return go(goBtn.dataset.go);
  const tabCard = t.closest('[data-tab]');
  if (tabCard) {
    buzz();
    return openTab(tabCard.dataset.tab);
  }
  if (t.closest('[data-ext]')) return toast('Terminal oturumu: telefondan sadece izlenir');
  const row = t.closest('[data-cwd]');
  if (row) return newSession(row);
  const z = t.closest('[data-zoom]');
  if (z) {
    const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + +z.dataset.zoom));
    zoom = ZOOMS[i] || 11;
    term.options.fontSize = zoom;
    store.set('ada.zoom', String(zoom));
    return;
  }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'back') history.back();
  else if (act === 'resume') {
    const id = S.tab;
    showOverlay('loading');
    try {
      const tab = await api(`/api/tabs/${encodeURIComponent(id)}/start`, {});
      S.tabs.set(tab.id, tab);
      // Bu sekmeye zaten aboneyiz: yeni çıktı mevcut akıştan gelir.
      hideOverlay();
      renderTabHead();
    } catch (err) {
      toast(err.message, true);
      showOverlay('closed');
    }
  } else if (act === 'forget') {
    C.token = '';
    C.base = '';
    store.set('ada.token', '');
    store.set('ada.server', '');
    S.loaded = false;
    connect();
    $('main').innerHTML = connHtml();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'connf') return;
  e.preventDefault();
  C.base = normBase($('f-server').value);
  C.token = $('f-token').value.trim();
  store.set('ada.server', C.base);
  store.set('ada.token', C.token);
  document.activeElement?.blur();
  C.retry = 0;
  S.loaded = false;
  connect();
  $('main').innerHTML = connHtml();
});

// ---------- Bildirim ----------
let toastTimer;
function toast(msg, err = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

// ---------- Ekran yüksekliği ----------
// Klavye açılınca (özellikle iOS) görünür alan küçülür; uygulama ona göre kısalır, giriş
// kutusu klavyenin üstünde kalır.
function fitViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');
  if (vv) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
fitViewport();

// ---------- Başlangıç ----------
loadConfig();
history.replaceState({ root: true }, '');
if (!C.token || (ON_PAGES && !C.base)) S.screen = 'conn';
render();
connect();
// Service worker sadece güvenli bağlamda (HTTPS) çalışır; evdeki http adreste atlanır.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
