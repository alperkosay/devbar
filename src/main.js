// Ada arayüzü: status bar, kapalı ada, terminal sekmeleri, tüm oturumlar, ayarlar, hatırlatıcılar.
const T = window.__TAURI__;
const invoke = T.core.invoke;
const appWin = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);
window.addEventListener('error', (e) => invoke('log', { msg: `${e.message} @ ${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => invoke('log', { msg: `promise: ${e.reason?.stack || e.reason}` }));

const island = $('island');
const peek = $('peek');
const remindEl = $('remind');
const chipsEl = $('chips');
const termsEl = $('terms');
const viewEl = $('view');
const bodyEl = $('body');

const PANEL = { w: 900, h: 560 };
const PEEK_H = 34;
const BAR = 30;

const S = {
  settings: { cwd: '', permissionMode: '', model: '', bar: true, recent: [], reminders: [] },
  tabs: [],
  agents: new Map(), // sessionId -> agent
  hooks: false,
  selected: null, // sekme id
  view: 'new', // term | new | all | settings
  open: false,
  picking: false,
  peekW: 150,
  remind: null, // gösterilen hatırlatıcı
  remote: null, // telefon erişimi durumu (remote_status)
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const folderName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const curTab = () => S.tabs.find((t) => t.id === S.selected) || null;
const tabAgent = (tabId) => [...S.agents.values()].find((a) => a.tab === tabId) || null;
const tabStatus = (t) => tabAgent(t.id)?.status || (t.alive ? 'idle' : 'off');
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'şimdi';
  if (s < 3600) return `${Math.floor(s / 60)} dk`;
  return `${Math.floor(s / 3600)} sa`;
};

// ---------- Oturum durumu ----------
const PRI = { waiting: 4, running: 3, done: 2, idle: 1 };
function visibleAgents() {
  const cut = Date.now() - 3 * 3600e3;
  return [...S.agents.values()]
    .filter((a) => a.status !== 'ended' && (a.updated > cut || a.status === 'running' || a.status === 'waiting'))
    .sort((a, b) => (PRI[b.status] || 0) - (PRI[a.status] || 0) || b.updated - a.updated);
}

function peekState() {
  const list = visibleAgents();
  for (const kind of ['waiting', 'running']) {
    const xs = list.filter((a) => a.status === kind);
    if (xs.length) return { kind, a: xs[0], extra: xs.length - 1 };
  }
  const un = list.filter((a) => a.unread && a.status === 'done');
  if (un.length) return { kind: 'done', a: un[0], extra: un.length - 1 };
  return { kind: 'idle', list };
}

// ---------- Geometri ----------
function islandSize() {
  if (S.open) return PANEL;
  if (S.remind) return { w: 380, h: (S.settings.bar ? BAR : 0) + 92 };
  return { w: S.peekW, h: S.settings.bar ? BAR + 4 : PEEK_H };
}

let lastHits = '';
function geometry() {
  const { w, h } = islandSize();
  island.style.setProperty('--w', w + 'px');
  island.style.setProperty('--h', h + 'px');
  const W = window.innerWidth;
  const m = S.open || S.remind ? 0 : 14;
  const rects = [[(W - w) / 2 - m, 0, w + 2 * m, h + (S.open || S.remind ? 0 : 6)]];
  if (S.settings.bar) rects.push([0, 0, W, BAR]);
  const key = JSON.stringify(rects);
  if (key !== lastHits) {
    lastHits = key;
    invoke('set_hits', { rects });
  }
}
window.addEventListener('resize', geometry);

// ---------- Aç / kapat ----------
let openedAt = 0;
async function openPanel(target) {
  if (S.remind) return;
  if (!S.open) {
    S.open = true;
    openedAt = Date.now();
    island.classList.add('open');
  }
  // Hap bir oturumu gösteriyorsa direkt ona git.
  const p = target === undefined ? peekState() : null;
  if (target) goTo(target);
  else if (p?.a) goTo(p.a);
  else if (S.view === 'term' && !curTab()) S.view = S.tabs.length ? 'term' : 'new';
  if (S.view === 'term' && !curTab()) S.selected = S.tabs[0]?.id ?? null;
  geometry();
  renderAll();
  await invoke('focus_window');
  setTimeout(focusActive, 120);
}

function goTo(a) {
  if (a.tab && S.tabs.some((t) => t.id === a.tab)) {
    S.selected = a.tab;
    S.view = 'term';
  } else {
    S.view = 'all';
  }
}

function closePanel(blurred = false) {
  if (!S.open) return;
  S.open = false;
  island.classList.remove('open');
  renderPeek();
  if (!blurred) invoke('release_focus');
  setTimeout(checkReminders, 600);
}

function focusActive() {
  if (S.view === 'term') terms.get(S.selected)?.term.focus();
}

// ---------- Kapalı ada ----------
function renderPeek() {
  const p = peekState();
  const bar = S.settings.bar;
  island.classList.toggle('busy', p.kind === 'running');
  island.classList.toggle('waiting', p.kind === 'waiting');
  if (p.kind === 'idle') {
    const list = p.list.slice(0, 5);
    const dots = list.map((a) => `<span class="dot ${a.status}"></span>`).join('');
    const count = bar && list.length ? `<span class="pk-dim">${p.list.length} oturum</span>` : '';
    peek.innerHTML = `<span class="pk-ic accent">${I.spark}</span><span class="pk-title">Ada</span>${count}<span class="pk-dots">${dots}</span>`;
    S.peekW = (bar ? 190 : 118) + list.length * 11;
  } else {
    const ic =
      p.kind === 'running' ? '<span class="spin"></span>' : `<span class="pk-ic ${p.kind}">${p.kind === 'waiting' ? I.bell : I.check}</span>`;
    const extra = p.extra > 0 ? `<span class="pk-badge">+${p.extra}</span>` : '';
    peek.innerHTML = `${ic}<span class="pk-text"><b>${esc(p.a.project)}</b><span>${esc(p.a.activity)}</span></span>${extra}`;
    S.peekW = 360;
  }
  geometry();
}

function flash(kind) {
  const cls = kind === 'waiting' ? 'flash-waiting' : 'flash-done';
  island.classList.remove('flash-done', 'flash-waiting');
  void island.offsetWidth;
  island.classList.add(cls);
  setTimeout(() => island.classList.remove(cls), 1700);
}

// ---------- Status bar ----------
const RICON = { water: I.water, stand: I.stand, eye: I.eye, bell: I.bell };
// Sade: solda marka, sağda oturumlar. Saat ve hatırlatıcı sayaçları sistemde zaten var.
function renderBar() {
  if (!S.settings.bar) return;
  $('tb-left').innerHTML = `<span class="tb-brand">${I.spark}Ada</span>`;
  const agents = visibleAgents().slice(0, 8);
  $('tb-right').innerHTML = agents
    .map(
      (a) =>
        `<button class="tb-chip agent ${a.status}" data-sid="${esc(a.sessionId)}" title="${esc(a.cwd)}\n${esc(a.activity)}"><span class="dot ${a.status}"></span><b>${esc(a.project)}</b></button>`,
    )
    .join('');
}
$('tb-right').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sid]');
  const a = b && S.agents.get(b.dataset.sid);
  if (a) openPanel(a);
});
$('tb-left').addEventListener('click', (e) => {
  if (e.target.closest('.tb-brand')) openPanel(null);
});
setInterval(renderBar, 10000);

// ---------- Panel ----------
function renderAll() {
  renderChips();
  renderBody();
}

function renderChips() {
  chipsEl.innerHTML = S.tabs
    .map((t) => {
      const a = tabAgent(t.id);
      const active = t.id === S.selected && S.view === 'term' ? 'active' : '';
      const tip = `${t.cwd}${a?.prompt ? '\n' + a.prompt : ''}`;
      return `<div class="chip ${active} ${a?.unread ? 'unread' : ''}" data-id="${t.id}" title="${esc(tip)}">
        <span class="dot ${tabStatus(t)}"></span><span class="t">${esc(folderName(t.cwd))}</span>
        <span class="x" data-close="${t.id}" title="Sekmeyi kapat">${I.x}</span></div>`;
    })
    .join('');
  $('btn-new').classList.toggle('active', S.view === 'new');
  $('btn-settings').classList.toggle('active', S.view === 'settings');
  const waiting = visibleAgents().filter((a) => a.status === 'waiting').length;
  $('btn-all').classList.toggle('active', S.view === 'all');
  $('btn-all').innerHTML = I.grid + (waiting ? `<span class="badge">${waiting}</span>` : '');
}

function renderBody() {
  const showTerm = S.view === 'term' && curTab();
  termsEl.hidden = !showTerm;
  viewEl.className = 'view';
  for (const [id, t] of terms) t.el.classList.toggle('on', showTerm && id === S.selected);

  if (showTerm) {
    const tab = curTab();
    if (tab.alive) {
      viewEl.innerHTML = '';
      requestAnimationFrame(() => fitActive());
    } else {
      viewEl.className = 'view overlay';
      viewEl.innerHTML = `<div class="closed">
        <div class="txt"><b>Oturum kapalı</b><span>${esc(tab.cwd)}</span></div>
        <button class="primary" data-act="resume">${I.play}<span>${tab.used ? 'Kaldığın yerden devam et' : 'Başlat'}</span></button></div>`;
    }
    return;
  }
  if (S.view === 'new') viewEl.innerHTML = newHtml();
  else if (S.view === 'all') viewEl.innerHTML = allHtml();
  else if (S.view === 'settings') viewEl.innerHTML = settingsHtml();
}

function newHtml() {
  const def = S.settings.cwd;
  const seen = new Set([def.toLowerCase()]);
  const recent = S.settings.recent.filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase())).slice(0, 6);
  const row = (p, tag) =>
    `<button class="frow" data-cwd="${esc(p)}"><span class="fi">${I.folder}</span><span class="ft"><b>${esc(folderName(p))}</b><span>${esc(p)}</span></span>${tag ? `<span class="tag">${tag}</span>` : ''}</button>`;
  return `<div class="newv">
    <h3>${I.spark}Yeni Claude oturumu</h3>
    <p>Bir klasör seç, içinde terminalde <b>claude</b> açılır. Tam erişim: izinler, slash komutlar, her şey.</p>
    ${row(def, 'Varsayılan')}
    ${recent.map((r) => row(r)).join('')}
    <button class="frow other" data-act="pick-new"><span class="fi">${I.plus}</span><span class="ft"><b>Başka klasör…</b><span>Bilgisayardan seç</span></span></button>
    <div class="hint"><span><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> aç/kapat</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> yeni satır</span></div>
  </div>`;
}

function allHtml() {
  const list = visibleAgents();
  if (!S.hooks) {
    return `<div class="empty-box"><div class="big">${I.link}</div><h4>Tüm oturumları görmek için hook'ları kur</h4>
      <p>Terminalde, VS Code'da ya da Ada'da açtığın her Claude Code oturumu durumunu Ada'ya bildirir: çalışıyor, izin bekliyor, bitti. Global <code>~/.claude/settings.json</code> dosyasına küçük bir <code>curl</code> hook'u eklenir, yedeği alınır. Ada kapalıyken Claude'u yavaşlatmaz.</p>
      <button class="primary" data-act="hooks-install">${I.link}<span>Hook'ları kur</span></button></div>`;
  }
  if (!list.length) {
    return `<div class="empty-box"><div class="big">${I.grid}</div><h4>Henüz oturum yok</h4>
      <p>Hook'lar kurulu. Açık Claude oturumların bir sonraki mesajda burada görünür. Yeni açtıkların hemen görünür.</p></div>`;
  }
  const waiting = list.filter((a) => a.status === 'waiting').length;
  const label = { running: 'Çalışıyor', waiting: 'Bekliyor', done: 'Bitti', idle: 'Hazır' };
  return `<div class="allv">
    <div class="sec-head">${I.grid}<h3>Tüm oturumlar</h3><span class="sub">${list.length} oturum${waiting ? ` · ${waiting} seni bekliyor` : ''}</span></div>
    ${list
      .map(
        (a) => `<button class="arow ${a.status}" data-sid="${esc(a.sessionId)}" title="${esc(a.cwd)}">
        <span class="dot ${a.status}"></span>
        <span class="pj"><b>${esc(a.project)}</b><span>${label[a.status] || a.status}</span></span>
        <span class="ac"><span class="a1">${esc(a.activity)}</span><span class="a2">${esc(a.prompt || '—')}</span></span>
        <span class="meta"><span class="src ${a.tab ? 'ada' : ''}">${a.tab ? 'Ada' : 'Terminal'}</span>${ago(a.updated)}</span></button>`,
      )
      .join('')}</div>`;
}

function settingsHtml() {
  const st = S.settings;
  const seg = (key, opts) =>
    `<div class="seg">${opts
      .map(
        ([v, l, ic]) =>
          `<button data-set="${key}" data-val="${v}" class="${String(st[key]) === v ? 'on' : ''} ${v === 'bypassPermissions' ? 'danger-on' : ''}">${ic || ''}${l}</button>`,
      )
      .join('')}</div>`;
  const permHint = {
    '': 'Claude Code ayarındaki varsayılan mod',
    acceptEdits: 'Dosya düzenlemelerini sormadan yapar',
    plan: 'Sadece okur ve plan çıkarır',
    bypassPermissions: 'Hiçbir şey sormaz, dikkatli kullan',
  }[st.permissionMode];
  const hooksCtl = S.hooks
    ? `<span class="ok-tag">${I.check}Kurulu</span><button class="mini" data-act="hooks-uninstall">Kaldır</button>`
    : `<button class="primary" data-act="hooks-install">${I.link}<span>Kur</span></button>`;
  const rems = st.reminders
    .map(
      (r, i) => `<div class="rrow"><span class="ri c-${r.icon}">${RICON[r.icon] || I.bell}</span><span class="rt">${esc(r.text)}</span>
      <div class="stepper"><button data-rem="${i}" data-d="-5">${I.minus}</button><span>${r.minutes} dk</span><button data-rem="${i}" data-d="5">${I.plus}</button></div>
      <button class="switch ${r.on ? 'on' : ''}" data-remon="${i}"></button></div>`,
    )
    .join('');
  return `<div class="settings">
    <div class="sec-head">${I.sliders}<h3>Ayarlar</h3><button class="mini" data-act="back">${I.x}<span>Kapat</span></button></div>
    <div class="row"><div class="lbl"><b>Görünüm</b><span>Status bar ekranın üstünde yer ayırır, pencereler altından başlar</span></div>
      ${seg('bar', [['true', 'Status bar', I.bar], ['false', 'Yüzen ada', I.float]])}</div>
    <div class="row"><div class="lbl"><b>Varsayılan klasör</b><span>Yeni oturum listesinde en üstte</span></div>
      <button class="pathbtn" data-act="pick" title="${esc(st.cwd)}">${I.folder}<span>${esc(st.cwd)}</span></button></div>
    <div class="row"><div class="lbl"><b>İzin modu</b><span>${esc(permHint)} · yeni sekmelerde geçerli</span></div>
      ${seg('permissionMode', [['', 'Varsayılan'], ['acceptEdits', 'Düzenleme'], ['plan', 'Plan'], ['bypassPermissions', 'Tam yetki']])}</div>
    <div class="row"><div class="lbl"><b>Model</b><span>Varsayılan, Claude Code ayarını kullanır</span></div>
      ${seg('model', [['', 'Varsayılan'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']])}</div>
    <div class="row"><div class="lbl"><b>Claude hook'ları</b><span>Tüm oturumların canlı durumu için</span></div><div class="keys">${hooksCtl}</div></div>
    ${remoteHtml()}
    <div class="row"><div class="lbl"><b>Hatırlatıcılar</b><span>Bilgisayar başında değilsen sayaç durur</span></div></div>
    ${rems}
    <div class="row"><div class="lbl"><b>Kısayol</b><span>Her yerden aç ve kapat</span></div><div class="keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd></div></div>
    <div class="row"><div class="lbl"><b>Uygulama</b><span>Açık terminaller kapanır</span></div><button class="danger" data-act="quit">${I.power}<span>Ada'yı kapat</span></button></div>
  </div>`;
}

// Telefon erişimi: açıkken QR kod. QR, adresi ve token'ı taşır; telefon okutunca bağlanır.
function remoteHtml() {
  const r = S.remote;
  const on = !!r?.on;
  const row = `<div class="row"><div class="lbl"><b>Telefon erişimi</b><span>Ev ağında telefondan oturumları izle, yanıtla, yeni oturum aç</span></div>
    <button class="switch ${on ? 'on' : ''}" data-act="remote-toggle" title="${on ? 'Kapat' : 'Aç'}"></button></div>`;
  if (!on) return row;
  let body;
  if (!r.running) {
    body = `<div class="rtext"><b class="err">Port ${r.port} açılamadı</b><span>Başka bir uygulama kullanıyor olabilir. Kapatıp tekrar aç.</span></div>`;
  } else if (!r.url) {
    body = `<div class="rtext"><b class="err">Yerel ağ adresi bulunamadı</b><span>Bilgisayar bir Wi-Fi ya da kablolu ağa bağlı mı?</span></div>`;
  } else {
    let qr = '';
    try {
      const q = qrcode(0, 'M');
      q.addData(r.url);
      q.make();
      qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
      invoke('log', { msg: 'qr: ' + e });
    }
    const addr = r.url.split('#')[0];
    body = `<div class="qr">${qr}</div>
      <div class="rtext">
        <b>${I.phone}Telefonun kamerasıyla okut</b>
        <span>Telefon aynı Wi-Fi'da olmalı. Adres: <code>${esc(addr)}</code></span>
        <span>İlk açılışta Windows güvenlik duvarı izin isteyebilir; <b>Özel ağlar</b>'a izin ver.</span>
        <span>QR'ı kimseyle paylaşma: içindeki token oturumlarına yazma izni verir.</span>
        <button class="mini" data-act="remote-regen">${I.refresh}<span>Token'ı yenile</span></button>
      </div>`;
  }
  return row + `<div class="remote">${body}</div>`;
}

async function loadRemote() {
  try {
    S.remote = await invoke('remote_status');
  } catch (e) {
    invoke('log', { msg: 'remote_status: ' + e });
  }
}

let toastTimer;
function toast(msg) {
  invoke('log', { msg: 'toast: ' + msg });
  bodyEl.querySelector('.toast')?.remove();
  bodyEl.insertAdjacentHTML('beforeend', `<div class="toast">${esc(msg)}</div>`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => bodyEl.querySelector('.toast')?.remove(), 5000);
}

// ---------- Terminaller ----------
const terms = new Map(); // sekme id -> { term, fit, el }
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

function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  termsEl.appendChild(el);
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.12,
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
    theme: XTHEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((data) => invoke('pty_write', { id, data }));
  term.onResize(({ cols, rows }) => invoke('pty_resize', { id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => {
    // Shift+Enter: Claude Code'da yeni satır (ESC + CR).
    if (e.key === 'Enter' && e.shiftKey) {
      if (e.type === 'keydown') invoke('pty_write', { id, data: '\x1b\r' });
      return false;
    }
    // Seçim varken Ctrl+C kopyalar, yoksa Claude'a kesme sinyali gider.
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      if (e.type === 'keydown') {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
      }
      return false;
    }
    // Ctrl+V: tarayıcının yapıştırma olayına bırak.
    if (e.ctrlKey && e.key.toLowerCase() === 'v') return false;
    return true;
  });
  const t = { term, fit, el };
  terms.set(id, t);
  return t;
}

function fitActive() {
  const t = terms.get(S.selected);
  if (!t || !t.el.classList.contains('on')) return;
  try {
    t.fit.fit();
  } catch {}
}
new ResizeObserver(() => fitActive()).observe(termsEl);

async function startTab(tab) {
  const t = ensureTerm(tab.id);
  S.selected = tab.id;
  S.view = 'term';
  renderAll();
  t.el.classList.add('on');
  await new Promise((r) => requestAnimationFrame(r));
  fitActive();
  try {
    const updated = await invoke('tab_start', { id: tab.id, cols: t.term.cols, rows: t.term.rows });
    Object.assign(tab, updated);
  } catch (e) {
    toast(e);
  }
  renderAll();
  t.term.focus();
}

// Sekmeyi listeye ekler ya da günceller (olay ve komut cevabı hangi sırayla gelirse gelsin tek kayıt).
function upsertTab(tab) {
  const cur = S.tabs.find((t) => t.id === tab.id);
  if (cur) {
    const changed = cur.alive !== tab.alive;
    Object.assign(cur, tab);
    return { tab: cur, isNew: false, changed };
  }
  S.tabs.push(tab);
  S.settings.recent = [tab.cwd, ...S.settings.recent.filter((r) => r.toLowerCase() !== tab.cwd.toLowerCase())].slice(0, 8);
  return { tab, isNew: true, changed: true };
}

async function newTab(cwd) {
  try {
    const { tab } = upsertTab(await invoke('tab_create', { cwd }));
    await startTab(tab);
  } catch (e) {
    toast(e);
  }
}

function select(id) {
  S.selected = id;
  S.view = 'term';
  const a = tabAgent(id);
  if (a?.unread) {
    a.unread = false;
    invoke('agent_read', { id: a.sessionId });
    renderPeek();
    renderBar();
  }
  renderAll();
  setTimeout(focusActive, 30);
}

async function closeTab(id) {
  await invoke('tab_close', { id });
  terms.get(id)?.term.dispose();
  terms.get(id)?.el.remove();
  terms.delete(id);
  S.tabs = S.tabs.filter((t) => t.id !== id);
  for (const [k, a] of S.agents) if (a.tab === id) S.agents.delete(k);
  if (S.selected === id) {
    S.selected = S.tabs.at(-1)?.id ?? null;
    S.view = S.selected ? 'term' : 'new';
  }
  renderAll();
  renderPeek();
  renderBar();
}

async function pickFolder(start) {
  S.picking = true;
  try {
    return await invoke('pick_folder', { start });
  } finally {
    S.picking = false;
    invoke('focus_window');
  }
}

async function saveSettings() {
  await invoke('save_settings', { settings: S.settings });
}

// ---------- Hatırlatıcılar ----------
const next = {}; // hatırlatıcı id -> sonraki zaman (ms)
const IDLE_RESET = 300; // 5 dk boşta kalınca sayaç baştan

async function checkReminders() {
  let idle = 0;
  try {
    idle = await invoke('idle_seconds');
  } catch {}
  const now = Date.now();
  for (const r of S.settings.reminders) {
    if (!r.on) {
      delete next[r.id];
      continue;
    }
    if (!next[r.id] || idle > IDLE_RESET) next[r.id] = now + r.minutes * 60000;
    else if (now >= next[r.id] && !S.remind && !S.open) showReminder(r);
  }
  renderBar();
}
setInterval(checkReminders, 15000);

function showReminder(r) {
  S.remind = r;
  remindEl.innerHTML = `<span class="rm-ic c-${r.icon}">${RICON[r.icon] || I.bell}</span>
    <span class="rm-text"><b>${esc(r.text)}</b><span>${r.minutes} dakikada bir hatırlatıyorum</span></span>
    <span class="rm-btns"><button class="rm-ok" data-rm="ok">Tamam</button><button class="rm-later" data-rm="later">10 dk sonra</button></span>`;
  island.classList.add('reminding');
  geometry();
}

remindEl.addEventListener('click', (e) => {
  const act = e.target.closest('[data-rm]')?.dataset.rm;
  if (!act || !S.remind) return;
  next[S.remind.id] = Date.now() + (act === 'ok' ? S.remind.minutes : 10) * 60000;
  S.remind = null;
  island.classList.remove('reminding');
  renderPeek();
  renderBar();
});

// ---------- Olaylar ----------
$('btn-new').innerHTML = I.plus;
$('btn-settings').innerHTML = I.sliders;
peek.addEventListener('click', () => openPanel());
$('btn-new').addEventListener('click', () => {
  S.view = 'new';
  renderAll();
});
$('btn-all').addEventListener('click', () => {
  S.view = S.view === 'all' ? (curTab() ? 'term' : 'new') : 'all';
  renderAll();
});
$('btn-settings').addEventListener('click', async () => {
  S.view = S.view === 'settings' ? (curTab() ? 'term' : 'new') : 'settings';
  if (S.view === 'settings') await loadRemote();
  renderAll();
});

chipsEl.addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) return closeTab(x.dataset.close);
  const chip = e.target.closest('.chip');
  if (chip) select(chip.dataset.id);
});
chipsEl.addEventListener(
  'wheel',
  (e) => {
    chipsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false },
);

viewEl.addEventListener('click', async (e) => {
  const cwd = e.target.closest('[data-cwd]')?.dataset.cwd;
  if (cwd) return newTab(cwd);
  const sid = e.target.closest('[data-sid]')?.dataset.sid;
  if (sid) {
    const a = S.agents.get(sid);
    if (a?.tab) select(a.tab);
    return;
  }
  const set = e.target.closest('[data-set]');
  if (set) {
    const key = set.dataset.set;
    S.settings[key] = key === 'bar' ? set.dataset.val === 'true' : set.dataset.val;
    await saveSettings();
    return renderBody();
  }
  const rem = e.target.closest('[data-rem]');
  if (rem) {
    const r = S.settings.reminders[+rem.dataset.rem];
    r.minutes = Math.min(240, Math.max(5, r.minutes + +rem.dataset.d));
    next[r.id] = Date.now() + r.minutes * 60000;
    await saveSettings();
    renderBar();
    return renderBody();
  }
  const remOn = e.target.closest('[data-remon]');
  if (remOn) {
    const r = S.settings.reminders[+remOn.dataset.remon];
    r.on = !r.on;
    delete next[r.id];
    await saveSettings();
    checkReminders();
    return renderBody();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'back') {
    S.view = curTab() ? 'term' : 'new';
    renderAll();
  } else if (act === 'pick') {
    const p = await pickFolder(S.settings.cwd);
    if (p) {
      S.settings.cwd = p;
      await saveSettings();
      renderBody();
    }
  } else if (act === 'pick-new') {
    const p = await pickFolder(S.settings.cwd);
    if (p) newTab(p);
  } else if (act === 'resume') {
    const tab = curTab();
    if (tab) startTab(tab);
  } else if (act === 'hooks-install' || act === 'hooks-uninstall') {
    try {
      S.hooks = await invoke(act.replace('-', '_'));
    } catch (err) {
      toast(err);
    }
    renderBody();
  } else if (act === 'remote-toggle') {
    try {
      S.remote = await invoke('remote_set', { on: !S.remote?.on });
    } catch (err) {
      toast(err);
      await loadRemote();
    }
    renderBody();
  } else if (act === 'remote-regen') {
    S.remote = await invoke('remote_regen');
    renderBody();
  } else if (act === 'quit') {
    invoke('quit');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.closest('.xterm')) return; // Esc terminalde Claude'a gider
  if (S.view === 'settings' || S.view === 'all') {
    S.view = curTab() ? 'term' : 'new';
    renderAll();
  } else closePanel();
});

// Butonlar odak almasın: kısayoldaki Space bırakılınca odaktaki butona tıklanmış sayılmasın.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button, .chip')) e.preventDefault();
});

T.event.listen('toggle', () => (S.open ? closePanel() : openPanel()));
// Tepsi menüsünden "Ayarlar".
T.event.listen('open-settings', async () => {
  if (!S.open) await openPanel(null);
  S.view = 'settings';
  renderAll();
});

// WebView odak değişirken anlık "odak kaybı" atabiliyor; kısa süre sonra tekrar bak.
appWin.onFocusChanged(({ payload: focused }) => {
  if (focused || !S.open || S.picking) return;
  const wait = Math.max(150, openedAt + 450 - Date.now());
  setTimeout(async () => {
    if (S.open && !S.picking && !(await appWin.isFocused())) closePanel(true);
  }, wait);
});

T.event.listen('pty', ({ payload }) => terms.get(payload.id)?.term.write(payload.data));
T.event.listen('pty-exit', ({ payload: id }) => {
  const tab = S.tabs.find((t) => t.id === id);
  if (tab) tab.alive = false;
  terms.get(id)?.term.write('\r\n\x1b[90m[oturum kapandı]\x1b[0m\r\n');
  if (S.open) renderAll();
});

// Sekme açıldı, başladı ya da kapandı. Telefondan açılan sekmeyi masaüstü burada öğrenir;
// terminali hemen kurulur ki ilk çıktı kaçmasın (görünür olunca fit edilir).
T.event.listen('tab', ({ payload }) => {
  const { tab, isNew, changed } = upsertTab(payload);
  if (isNew) {
    const ref = terms.get(S.selected) || [...terms.values()][0];
    const t = ensureTerm(tab.id);
    if (ref) t.term.resize(ref.term.cols, ref.term.rows);
  }
  if (!changed) return;
  if (S.open) {
    renderChips();
    if (S.view === 'term' && S.selected === tab.id) renderBody();
  }
});

T.event.listen('agent', ({ payload: a }) => {
  const prev = S.agents.get(a.sessionId);
  if (a.status === 'ended') S.agents.delete(a.sessionId);
  else S.agents.set(a.sessionId, a);
  if (a.tab) {
    const tab = S.tabs.find((t) => t.id === a.tab);
    if (tab && a.status === 'running') tab.used = true;
  }
  const viewing = S.open && S.view === 'term' && S.selected === a.tab;
  if (viewing && a.unread) {
    a.unread = false;
    invoke('agent_read', { id: a.sessionId });
  }
  if (!viewing && prev?.status !== a.status && (a.status === 'done' || a.status === 'waiting')) flash(a.status);
  renderPeek();
  renderBar();
  if (S.open) {
    renderChips();
    if (S.view === 'all') renderBody();
  }
});
T.event.listen('agent-remove', ({ payload: id }) => {
  S.agents.delete(id);
  renderPeek();
  renderBar();
  if (S.open) renderChips();
});

T.event.listen('layout', ({ payload: bar }) => {
  S.settings.bar = bar;
  document.body.classList.toggle('bar-mode', bar);
  lastHits = '';
  renderPeek();
  renderBar();
});

// ---------- Başlangıç ----------
(async () => {
  const st = await invoke('get_state');
  S.settings = st.settings;
  S.tabs = st.tabs;
  S.hooks = st.hooks;
  for (const a of st.agents) S.agents.set(a.sessionId, a);
  S.view = S.tabs.length ? 'term' : 'new';
  S.selected = S.tabs.at(-1)?.id ?? null;
  document.body.classList.toggle('bar-mode', S.settings.bar);
  renderPeek();
  renderAll();
  await document.fonts.ready;
  await invoke('ready');
  checkReminders();
})();
