// DevBar ana penceresi: bütün oturumlar ekrana döşenmiş, yan yana açık. Her panelde gerçek
// Claude Code terminali. Üstte ince araç çubuğu; ayarlar, yeni oturum ve diğer oturumlar
// panellerin üstünde açılan pencerede.
const gridEl = $('grid');
const overlay = $('overlay');
const modal = $('modal');

const S = {
  settings: { cwd: '', permissionMode: '', model: '', bar: true, recent: [], reminders: [] },
  tabs: [],
  agents: new Map(), // sessionId -> oturum
  hooks: false,
  remote: null,
  active: null, // odaktaki panel (sekme id)
  zoom: null, // tek başına büyütülmüş panel
  modal: null, // new | others | ext | settings
  ext: null, // dış oturum session id
  renaming: null, // adı düzenlenen sekme id
  closing: null, // kapatma onayı bekleyen sekme id
};

const tabName = (t) => t.name || folderName(t.cwd);
const tabAgent = (tabId) => [...S.agents.values()].find((a) => a.tab === tabId) || null;
const tabStatus = (t) => (t.alive ? tabAgent(t.id)?.status || 'idle' : 'off');
const others = () => sortedAgents(S.agents).filter((a) => !a.tab);

// ---------- Paneller ----------
const panes = new Map(); // sekme id -> { el, head, body, cover }

function ensurePane(tab) {
  if (panes.has(tab.id)) return panes.get(tab.id);
  const el = document.createElement('section');
  el.className = 'pane';
  el.dataset.pane = tab.id;
  el.innerHTML = `<div class="ph"></div><div class="pb"></div><div class="cover" hidden></div>`;
  const p = { el, head: el.querySelector('.ph'), body: el.querySelector('.pb'), cover: el.querySelector('.cover') };
  panes.set(tab.id, p);
  gridEl.appendChild(el);
  return p;
}

// Panel sayısına göre ızgara: 1, 2, 3 yan yana; 4 = 2x2; 5-6 = 3x2; 7-9 = 3x3; fazlası 4 sütun.
function gridSize(n) {
  const cols = n <= 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : n === 4 ? 2 : n <= 9 ? 3 : 4;
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

function layout() {
  for (const [id, p] of panes) {
    if (!S.tabs.some((t) => t.id === id)) {
      p.el.remove();
      panes.delete(id);
      terms.get(id)?.term.dispose();
      terms.delete(id);
    }
  }
  if (S.zoom && !S.tabs.some((t) => t.id === S.zoom)) S.zoom = null;
  const visible = S.zoom ? S.tabs.filter((t) => t.id === S.zoom) : S.tabs;

  gridEl.querySelector('.welcome')?.remove();
  S.tabs.forEach((t, i) => {
    const p = ensurePane(t);
    if (gridEl.children[i] !== p.el) gridEl.insertBefore(p.el, gridEl.children[i] || null);
    p.el.hidden = !visible.includes(t);
    renderPane(t);
  });
  if (!S.tabs.length) gridEl.insertAdjacentHTML('beforeend', welcomeHtml());

  const { cols, rows } = gridSize(visible.length || 1);
  gridEl.style.setProperty('--cols', cols);
  gridEl.style.setProperty('--rows', rows);
  // Çok panelde yazı biraz küçülsün ki Claude'un ekranı sığsın.
  const size = visible.length >= 4 ? 12 : 13;
  for (const t of terms.values()) if (t.term.options.fontSize !== size) t.term.options.fontSize = size;
  requestAnimationFrame(fitAll);
  renderTop();
}

function renderPane(t) {
  const p = panes.get(t.id);
  if (!p) return;
  const a = tabAgent(t.id);
  const st = tabStatus(t);
  p.el.className = `pane ${st} ${S.active === t.id ? 'active' : ''} ${a?.unread ? 'unread' : ''}`;
  const name =
    S.renaming === t.id
      ? `<input class="rename" id="rename" value="${esc(tabName(t))}" placeholder="${esc(folderName(t.cwd))}" spellcheck="false">`
      : `<b class="pn" title="${esc(t.cwd)}">${esc(tabName(t))}</b>`;
  const closing = S.closing === t.id;
  p.head.innerHTML = `<span class="dot ${st}"></span>${name}
    <span class="ps">${esc(t.alive ? a?.short || a?.activity || 'Hazır' : 'Kapalı')}</span>
    <span class="pa">
      <button data-pact="rename" title="Yeniden adlandır">${I.pen}</button>
      <button data-pact="zoom" title="${S.zoom === t.id ? 'Izgaraya dön' : 'Büyüt'}">${S.zoom === t.id ? I.grid : I.ext}</button>
      <button data-pact="close" class="${closing ? 'armed' : ''}" title="Oturumu kapat">${closing ? 'Kapatılsın mı?' : I.x}</button>
    </span>`;
  p.cover.hidden = t.alive;
  if (!t.alive)
    p.cover.innerHTML = `<div class="cv"><b>${t.used ? 'Oturum kapalı' : 'Başlamadı'}</b><span>${esc(t.cwd)}</span>
      <button class="primary" data-pact="resume">${I.play}<span>${t.used ? 'Kaldığın yerden devam et' : 'Başlat'}</span></button></div>`;
  if (S.renaming === t.id) {
    const inp = $('rename');
    inp?.focus();
    inp?.select();
  }
}

function renderTop() {
  const live = S.tabs.filter((t) => t.alive);
  const count = (k) => S.tabs.filter((t) => t.alive && tabStatus(t) === k).length;
  const parts = [];
  if (count('waiting')) parts.push(`<span class="sp waiting"><span class="dot waiting"></span>${count('waiting')} bekliyor</span>`);
  if (count('running')) parts.push(`<span class="sp"><span class="dot running"></span>${count('running')} çalışıyor</span>`);
  parts.push(`<span class="sp muted">${S.tabs.length} panel${live.length !== S.tabs.length ? ` · ${S.tabs.length - live.length} kapalı` : ''}</span>`);
  $('sum').innerHTML = S.tabs.length ? parts.join('') : '';
  const closed = S.tabs.filter((t) => !t.alive).length;
  const ext = others().length;
  $('tbr').innerHTML = `
    ${closed > 1 ? `<button class="tbtn" data-top="resume-all">${I.play}<span>Hepsini başlat (${closed})</span></button>` : ''}
    <button class="tbtn" data-top="others" title="Terminal ve VS Code'daki oturumlar">${I.list}<span>Diğer</span>${ext ? `<i>${ext}</i>` : ''}</button>
    <button class="tbtn go" data-top="new">${I.plus}<span>Yeni oturum</span></button>
    <button class="tbtn icon" data-top="settings" title="Ayarlar">${I.sliders}</button>`;
}

function welcomeHtml() {
  return `<div class="welcome"><div class="big">${I.spark}</div><h2>Henüz oturum yok</h2>
    <p>Açtığın her Claude oturumu burada yan yana durur. 5-6 projeyi aynı anda görebilirsin.</p>
    <button class="primary" data-top="new">${I.plus}<span>Yeni oturum</span></button></div>`;
}

function activate(id, focus = true) {
  if (!S.tabs.some((t) => t.id === id)) return;
  const prev = S.active;
  S.active = id;
  const a = tabAgent(id);
  if (a?.unread) {
    a.unread = false;
    invoke('agent_read', { id: a.sessionId });
  }
  if (prev && prev !== id) renderPane(S.tabs.find((t) => t.id === prev) || {});
  renderPane(S.tabs.find((t) => t.id === id));
  if (focus) setTimeout(() => terms.get(id)?.term.focus(), 20);
}

// ---------- Açılan pencere (ayarlar, yeni oturum, diğer oturumlar) ----------
async function openModal(kind) {
  S.modal = kind;
  if (kind === 'settings') await loadRemote();
  renderModal();
  overlay.hidden = false;
}
function closeModal() {
  S.modal = null;
  overlay.hidden = true;
  if (S.active) terms.get(S.active)?.term.focus();
}
function renderModal() {
  if (!S.modal) return;
  const head = (icon, title, sub, back) =>
    `<div class="mh">${back ? `<button class="mini" data-m="${back}">${I.left}</button>` : ''}<span class="mi">${icon}</span><div class="mt"><h2>${title}</h2><span>${sub}</span></div><button class="mini" data-m="close">${I.x}</button></div>`;
  let html = '';
  if (S.modal === 'new') html = head(I.spark, 'Yeni oturum', 'Klasörü seç, yeni panelde Claude Code açılır') + newHtml();
  else if (S.modal === 'settings') html = head(I.sliders, 'Ayarlar', 'Hepsi hemen kaydedilir') + settingsHtml();
  else if (S.modal === 'others') html = head(I.list, 'Diğer oturumlar', 'Terminal ve VS Code\'da açık Claude oturumların') + othersHtml();
  else if (S.modal === 'ext') {
    const a = S.agents.get(S.ext);
    html = head(I.eye, esc(a ? nameOf(a) : 'Oturum'), a ? esc(a.cwd) : '', 'others') + extHtml();
  }
  modal.innerHTML = html;
}

function newHtml() {
  const def = S.settings.cwd;
  const seen = new Set([def.toLowerCase()]);
  const recent = (S.settings.recent || []).filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase())).slice(0, 8);
  const row = (p, tag) =>
    `<button class="frow" data-cwd="${esc(p)}"><span class="fi">${I.folder}</span><span class="ft"><b>${esc(folderName(p))}</b><span>${esc(p)}</span></span>${tag ? `<span class="tag">${tag}</span>` : ''}</button>`;
  return `<div class="newv">
    ${row(def, 'Varsayılan')}
    ${recent.map((r) => row(r)).join('')}
    <button class="frow other" data-act="pick-new"><span class="fi">${I.plus}</span><span class="ft"><b>Başka klasör…</b><span>Bilgisayardan seç</span></span></button>
  </div>`;
}

function othersHtml() {
  const list = others();
  if (!list.length)
    return S.hooks
      ? `<div class="empty-box"><p>Terminalde açık Claude oturumların bir sonraki mesajda burada görünür.</p></div>`
      : `<div class="empty-box"><p>Terminal ve VS Code oturumlarını da görmek için hook'ları kur.</p><button class="primary" data-act="hooks-install">${I.link}<span>Hook'ları kur</span></button></div>`;
  return `<div class="olist">${list
    .map(
      (a) => `<button class="orow ${a.status}" data-sid="${esc(a.sessionId)}"><span class="dot ${a.status}"></span>
        <span class="ot"><b>${esc(nameOf(a))}</b><span>${esc(a.short || a.activity)}${a.prompt ? ' · ' + esc(a.prompt) : ''}</span></span>
        <span class="when">${ago(a.updated)}</span>${I.right}</button>`,
    )
    .join('')}</div>`;
}

function extHtml() {
  const a = S.agents.get(S.ext);
  if (!a) return `<div class="empty-box"><p>Bu oturum artık açık değil.</p></div>`;
  const live = a.status === 'running' || a.status === 'waiting';
  return `<div class="extv">
    <dl class="facts">
      <dt>Durum</dt><dd>${STATUS_LABEL[a.status] || a.status}</dd>
      <dt>Şu an</dt><dd>${esc(a.activity || '—')}</dd>
      <dt>Son mesaj</dt><dd>${esc(a.prompt || '—')}</dd>
      <dt>Klasör</dt><dd>${esc(a.cwd)}</dd>
      <dt>Son hareket</dt><dd>${ago(a.updated)} önce</dd>
    </dl>
    ${live ? `<div class="note warn">${I.alert}<span>Oturum şu an açık. DevBar'da devam edersen iki yerden aynı anda yazma; önce diğer pencerede kapat.</span></div>` : ''}
    <div><button class="primary" data-act="adopt">${I.play}<span>Panel olarak DevBar'da aç</span></button></div>
  </div>`;
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
  const rems = (st.reminders || [])
    .map(
      (r, i) => `<div class="rrow"><span class="ri c-${r.icon}">${RICON[r.icon] || I.bell}</span><span class="rt">${esc(r.text)}</span>
      <div class="stepper"><button data-rem="${i}" data-d="-5">${I.minus}</button><span>${r.minutes} dk</span><button data-rem="${i}" data-d="5">${I.plus}</button></div>
      <button class="switch ${r.on ? 'on' : ''}" data-remon="${i}"></button></div>`,
    )
    .join('');
  return `<div class="settings">
    <div class="row"><div class="lbl"><b>Üst bar</b><span>Status bar ekranın üstünde yer ayırır; yüzen ada sadece küçük bir sekme</span></div>
      ${seg('bar', [['true', 'Status bar', I.bar], ['false', 'Yüzen ada', I.float]])}</div>
    <div class="row"><div class="lbl"><b>Bar teması</b><span>${esc((THEMES.find(([k]) => k === (st.theme || 'gece')) || ['', 'Obsidyen'])[1])}</span></div>
      <div class="themes">${THEMES.map(([k, l]) => `<button class="sw ${k} ${(st.theme || 'gece') === k ? 'on' : ''}" data-themepick="${k}" title="${l}"></button>`).join('')}</div></div>
    <div class="row"><div class="lbl"><b>Varsayılan klasör</b><span>Yeni oturum listesinde en üstte</span></div>
      <button class="pathbtn" data-act="pick" title="${esc(st.cwd)}">${I.folder}<span>${esc(st.cwd)}</span></button></div>
    <div class="row"><div class="lbl"><b>İzin modu</b><span>${esc(permHint)} · yeni oturumlarda geçerli</span></div>
      ${seg('permissionMode', [['', 'Varsayılan'], ['acceptEdits', 'Düzenleme'], ['plan', 'Plan'], ['bypassPermissions', 'Tam yetki']])}</div>
    <div class="row"><div class="lbl"><b>Model</b><span>Varsayılan, Claude Code ayarını kullanır</span></div>
      ${seg('model', [['', 'Varsayılan'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']])}</div>
    <div class="row"><div class="lbl"><b>Claude hook'ları</b><span>Terminal ve VS Code oturumlarının da durumu görünsün. Global ayara eklenir, yedeği alınır.</span></div><div class="keys">${hooksCtl}</div></div>
    ${remoteHtml()}
    <div class="row"><div class="lbl"><b>Hatırlatıcılar</b><span>Windows bildirimi olarak gelir; 5 dk bilgisayar başında değilsen sayaç baştan başlar</span></div></div>
    ${rems}
    <div class="row"><div class="lbl"><b>Kısayol</b><span>DevBar penceresini her yerden aç / gizle</span></div><div class="keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd></div></div>
    <div class="row"><div class="lbl"><b>Uygulama</b><span>Pencereyi kapatmak DevBar'ı kapatmaz; tamamen çıkmak için</span></div><button class="danger" data-act="quit">${I.power}<span>DevBar'dan çık</span></button></div>
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
  document.querySelector('.toast')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="toast">${esc(msg)}</div>`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => document.querySelector('.toast')?.remove(), 5000);
}

// ---------- Terminaller ----------
const terms = new Map(); // sekme id -> { term, fit, el }
const XTHEME = {
  background: '#0b0b0e',
  foreground: '#e4e4e7',
  cursor: '#e8835e',
  cursorAccent: '#0b0b0e',
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
  const pane = panes.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  pane.body.appendChild(el);
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: S.tabs.length >= 4 ? 12 : 13,
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
  // Terminale tıklanınca o panel odaklansın.
  term.textarea?.addEventListener('focus', () => S.active !== id && activate(id, false));
  const t = { term, fit, el };
  terms.set(id, t);
  return t;
}

function fitAll() {
  for (const [id, t] of terms) {
    if (panes.get(id)?.el.hidden) continue;
    try {
      t.fit.fit();
    } catch {}
  }
}
let fitTimer;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitAll, 60);
}).observe(gridEl);

async function startTab(tab) {
  ensurePane(tab);
  const t = ensureTerm(tab.id);
  layout();
  await new Promise((r) => requestAnimationFrame(r));
  try {
    t.fit.fit();
  } catch {}
  try {
    Object.assign(tab, await invoke('tab_start', { id: tab.id, cols: t.term.cols, rows: t.term.rows }));
  } catch (e) {
    toast(e);
  }
  layout();
  activate(tab.id);
}

// Sekmeyi listeye ekler ya da günceller (olay ve komut cevabı hangi sırayla gelirse gelsin tek kayıt).
function upsertTab(tab) {
  const cur = S.tabs.find((t) => t.id === tab.id);
  if (cur) {
    const changed = cur.alive !== tab.alive || cur.name !== tab.name;
    Object.assign(cur, tab);
    return { tab: cur, isNew: false, changed };
  }
  S.tabs.push(tab);
  S.settings.recent = [tab.cwd, ...(S.settings.recent || []).filter((r) => r.toLowerCase() !== tab.cwd.toLowerCase())].slice(0, 8);
  return { tab, isNew: true, changed: true };
}

async function newTab(cwd, resume = null) {
  try {
    const { tab } = upsertTab(await invoke('tab_create', { cwd, resume }));
    S.zoom = null;
    closeModal();
    await startTab(tab);
  } catch (e) {
    toast(e);
  }
}

async function closeTab(id) {
  await invoke('tab_close', { id });
  S.tabs = S.tabs.filter((t) => t.id !== id);
  for (const [k, a] of S.agents) if (a.tab === id) S.agents.delete(k);
  if (S.active === id) S.active = S.tabs.at(-1)?.id ?? null;
  if (S.zoom === id) S.zoom = null;
  S.closing = null;
  layout();
}

function saveRename(id, value) {
  S.renaming = null;
  const tab = S.tabs.find((t) => t.id === id);
  if (tab) {
    tab.name = value.trim();
    invoke('rename', { target: id, name: value });
    renderPane(tab);
  }
}

// Bar ya da bildirimden gelen hedef: oturum id'si ya da sekme id'si.
function goTarget(target) {
  if (!target) return;
  const a = S.agents.get(target);
  const tabId = a?.tab && S.tabs.some((t) => t.id === a.tab) ? a.tab : S.tabs.some((t) => t.id === target) ? target : null;
  if (tabId) {
    closeModal();
    if (S.zoom && S.zoom !== tabId) {
      S.zoom = null;
      layout();
    }
    return activate(tabId);
  }
  if (a) {
    S.ext = target;
    openModal('ext');
  }
}

async function pickFolder(start) {
  return invoke('pick_folder', { start });
}

async function saveSettings() {
  await invoke('save_settings', { settings: S.settings });
}

// ---------- Tıklamalar ----------
$('logo').innerHTML = `${I.spark}<b>DevBar</b>`;

document.addEventListener('click', async (e) => {
  const top = e.target.closest('[data-top]')?.dataset.top;
  if (top === 'new' || top === 'settings' || top === 'others') return openModal(top);
  if (top === 'resume-all') {
    for (const t of S.tabs.filter((x) => !x.alive)) await startTab(t);
    return;
  }
});

gridEl.addEventListener('click', (e) => {
  const pane = e.target.closest('[data-pane]');
  if (!pane) return;
  const id = pane.dataset.pane;
  const tab = S.tabs.find((t) => t.id === id);
  const act = e.target.closest('[data-pact]')?.dataset.pact;
  if (act === 'close') {
    if (S.closing === id) return closeTab(id);
    S.closing = id;
    renderPane(tab);
    setTimeout(() => {
      if (S.closing === id) {
        S.closing = null;
        renderPane(tab);
      }
    }, 3000);
    return;
  }
  if (act === 'zoom') {
    S.zoom = S.zoom === id ? null : id;
    layout();
    return activate(id);
  }
  if (act === 'rename') {
    S.renaming = id;
    return renderPane(tab);
  }
  if (act === 'resume') return startTab(tab);
  if (e.target.id !== 'rename') activate(id);
});
gridEl.addEventListener('dblclick', (e) => {
  const pn = e.target.closest('.pn');
  const pane = e.target.closest('[data-pane]');
  if (pn && pane) {
    S.renaming = pane.dataset.pane;
    renderPane(S.tabs.find((t) => t.id === S.renaming));
  }
});
gridEl.addEventListener('keydown', (e) => {
  if (e.target.id !== 'rename') return;
  const id = e.target.closest('[data-pane]')?.dataset.pane;
  if (e.key === 'Enter') saveRename(id, e.target.value);
  else if (e.key === 'Escape') {
    S.renaming = null;
    renderPane(S.tabs.find((t) => t.id === id));
  }
});
gridEl.addEventListener('focusout', (e) => {
  if (e.target.id === 'rename' && S.renaming) saveRename(S.renaming, e.target.value);
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.modal && !e.target.closest('.xterm')) closeModal();
});

modal.addEventListener('click', async (e) => {
  const m = e.target.closest('[data-m]')?.dataset.m;
  if (m === 'close') return closeModal();
  if (m) return openModal(m);
  const cwd = e.target.closest('[data-cwd]')?.dataset.cwd;
  if (cwd) return newTab(cwd);
  const sid = e.target.closest('[data-sid]')?.dataset.sid;
  if (sid) {
    S.ext = sid;
    return openModal('ext');
  }
  const set = e.target.closest('[data-set]');
  if (set) {
    const key = set.dataset.set;
    S.settings[key] = key === 'bar' ? set.dataset.val === 'true' : set.dataset.val;
    await saveSettings();
    return renderModal();
  }
  const tp = e.target.closest('[data-themepick]');
  if (tp) {
    S.settings.theme = tp.dataset.themepick;
    await invoke('set_theme', { theme: S.settings.theme });
    return renderModal();
  }
  const rem = e.target.closest('[data-rem]');
  if (rem) {
    const r = S.settings.reminders[+rem.dataset.rem];
    r.minutes = Math.min(240, Math.max(5, r.minutes + +rem.dataset.d));
    await saveSettings();
    return renderModal();
  }
  const remOn = e.target.closest('[data-remon]');
  if (remOn) {
    const r = S.settings.reminders[+remOn.dataset.remon];
    r.on = !r.on;
    await saveSettings();
    return renderModal();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'pick') {
    const p = await pickFolder(S.settings.cwd);
    if (p) {
      S.settings.cwd = p;
      await saveSettings();
      renderModal();
    }
  } else if (act === 'pick-new') {
    const p = await pickFolder(S.settings.cwd);
    if (p) newTab(p);
  } else if (act === 'adopt') {
    const a = S.agents.get(S.ext);
    if (a) newTab(a.cwd, a.sessionId);
  } else if (act === 'hooks-install' || act === 'hooks-uninstall') {
    try {
      S.hooks = await invoke(act.replace('-', '_'));
    } catch (err) {
      toast(err);
    }
    renderModal();
  } else if (act === 'remote-toggle') {
    try {
      S.remote = await invoke('remote_set', { on: !S.remote?.on });
    } catch (err) {
      toast(err);
      await loadRemote();
    }
    renderModal();
  } else if (act === 'remote-regen') {
    S.remote = await invoke('remote_regen');
    renderModal();
  } else if (act === 'quit') {
    invoke('quit');
  }
});

// ---------- Olaylar ----------
T.event.listen('select', ({ payload }) => goTarget(payload));
// Bardaki menüden "bu klasörde Claude".
T.event.listen('new-tab', ({ payload: cwd }) => newTab(cwd));
T.event.listen('show-new', () => openModal('new'));
T.event.listen('open-settings', () => openModal('settings'));
T.event.listen('settings', ({ payload }) => {
  S.settings = payload;
  if (S.modal === 'settings') renderModal();
});

T.event.listen('pty', ({ payload }) => terms.get(payload.id)?.term.write(payload.data));
T.event.listen('pty-exit', ({ payload: id }) => {
  const tab = S.tabs.find((t) => t.id === id);
  if (tab) tab.alive = false;
  terms.get(id)?.term.write('\r\n\x1b[90m[oturum kapandı]\x1b[0m\r\n');
  if (tab) renderPane(tab);
  renderTop();
});

// Sekme açıldı, başladı ya da kapandı. Telefondan açılan sekme burada öğrenilir;
// paneli ve terminali hemen kurulur ki ilk çıktı kaçmasın.
T.event.listen('tab', ({ payload }) => {
  const { tab, isNew, changed } = upsertTab(payload);
  if (isNew) {
    ensurePane(tab);
    ensureTerm(tab.id);
    layout();
  } else if (changed) {
    renderPane(tab);
    renderTop();
  }
});

T.event.listen('agent', ({ payload: a }) => {
  if (a.status === 'ended') S.agents.delete(a.sessionId);
  else S.agents.set(a.sessionId, a);
  const tab = a.tab ? S.tabs.find((t) => t.id === a.tab) : null;
  if (tab && a.status === 'running') tab.used = true;
  if (tab && document.hasFocus() && S.active === tab.id && a.unread) {
    a.unread = false;
    invoke('agent_read', { id: a.sessionId });
  }
  if (tab) renderPane(tab);
  renderTop();
  if (S.modal === 'others' || (S.modal === 'ext' && S.ext === a.sessionId)) renderModal();
});
T.event.listen('agent-remove', ({ payload: id }) => {
  S.agents.delete(id);
  renderTop();
  if (S.modal === 'others') renderModal();
});

// ---------- Başlangıç ----------
(async () => {
  const st = await getState();
  S.settings = st.settings;
  S.tabs = st.tabs;
  S.hooks = st.hooks;
  for (const a of st.agents) S.agents.set(a.sessionId, a);
  await loadRemote();
  S.active = S.tabs.at(-1)?.id ?? null;
  layout();
})();
