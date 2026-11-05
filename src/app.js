// Ada ana penceresi: solda oturumlar (Ada'dakiler ve dışarıdakiler), sağda seçili oturumun
// gerçek terminali ve altta mesaj kutusu. Yeni oturum, dış oturum ayrıntısı ve ayarlar da burada.
const termsEl = $('terms');
const viewEl = $('view');
const bodyEl = $('body');
const composer = $('composer');
const input = $('input');

const S = {
  settings: { cwd: '', permissionMode: '', model: '', bar: true, recent: [], reminders: [] },
  tabs: [],
  agents: new Map(), // sessionId -> oturum
  hooks: false,
  remote: null,
  view: 'new', // term | new | ext | settings
  selected: null, // sekme id (term görünümü)
  ext: null, // dış oturum session id (ext görünümü)
};

const curTab = () => S.tabs.find((t) => t.id === S.selected) || null;
const tabAgent = (tabId) => [...S.agents.values()].find((a) => a.tab === tabId) || null;
const tabStatus = (t) => (t.alive ? tabAgent(t.id)?.status || 'idle' : 'off');

// ---------- Çizim ----------
function renderAll() {
  renderSide();
  renderHead();
  renderBody();
}

function renderSide() {
  const tabs = S.tabs
    .map((t) => {
      const a = tabAgent(t.id);
      const st = tabStatus(t);
      const sub = !t.alive ? (t.used ? 'Kapalı · devam edebilirsin' : 'Kapalı') : a?.activity || 'Hazır';
      const cls = [st, S.view === 'term' && S.selected === t.id ? 'active' : '', a?.unread ? 'unread' : ''].join(' ');
      return `<button class="item ${cls}" data-tab="${t.id}" title="${esc(t.cwd)}${a?.prompt ? '\n' + esc(a.prompt) : ''}">
        <span class="dot ${st}"></span><span class="it"><b>${esc(folderName(t.cwd))}</b><span>${esc(sub)}</span></span>
        <span class="x" data-close="${t.id}" title="Oturumu kapat">${I.x}</span></button>`;
    })
    .join('');
  $('tablist').innerHTML =
    tabs || `<div class="empty-side">Henüz oturum yok. <button data-act="new">Yeni oturum aç</button></div>`;

  const ext = sortedAgents(S.agents).filter((a) => !a.tab);
  $('extlist').innerHTML = ext.length
    ? ext
        .map(
          (a) => `<button class="item ${a.status} ${S.view === 'ext' && S.ext === a.sessionId ? 'active' : ''}" data-sid="${esc(a.sessionId)}" title="${esc(a.cwd)}">
        <span class="dot ${a.status}"></span><span class="it"><b>${esc(a.project)}</b><span>${esc(a.activity)}</span></span>
        <span class="when">${ago(a.updated)}</span></button>`,
        )
        .join('')
    : S.hooks
      ? `<div class="empty-side">Terminalde açık Claude oturumların bir sonraki mesajda burada görünür.</div>`
      : `<div class="empty-side">Terminal ve VS Code oturumlarını da görmek için <button data-act="go-settings">hook'ları kur</button>.</div>`;

  $('btn-new').classList.toggle('active', S.view === 'new');
  $('btn-settings').classList.toggle('active', S.view === 'settings');
  $('phone-ind').innerHTML = S.remote?.on ? `${I.phone}Telefon açık` : '';
}

function renderHead() {
  let html = '';
  if (S.view === 'term' && curTab()) {
    const t = curTab();
    const a = tabAgent(t.id);
    const st = tabStatus(t);
    html = `<div class="mh-main"><div class="mh-title"><span class="dot ${st}"></span><h2>${esc(folderName(t.cwd))}</h2><span class="pill ${st}">${STATUS_LABEL[st]}</span></div>
      <div class="mh-sub">${esc(t.cwd)}${a?.activity && t.alive ? ' · ' + esc(a.activity) : ''}</div></div>
      <div class="mh-actions"><button class="mini danger" data-act="close-tab">${I.x}<span>Oturumu kapat</span></button></div>`;
  } else if (S.view === 'ext') {
    const a = S.agents.get(S.ext);
    html = a
      ? `<div class="mh-main"><div class="mh-title"><span class="dot ${a.status}"></span><h2>${esc(a.project)}</h2><span class="pill ${a.status}">${STATUS_LABEL[a.status] || a.status}</span></div>
        <div class="mh-sub">${esc(a.cwd)} · Ada dışında çalışıyor</div></div>`
      : '';
  } else if (S.view === 'settings') {
    html = `<div class="mh-main"><div class="mh-title">${I.sliders}<h2>Ayarlar</h2></div><div class="mh-sub">Tüm ayarlar hemen kaydedilir</div></div>`;
  } else {
    html = `<div class="mh-main"><div class="mh-title">${I.spark}<h2>Yeni oturum</h2></div><div class="mh-sub">Bir klasör seç, içinde Claude Code açılır</div></div>`;
  }
  $('mhead').innerHTML = html;
}

function renderBody() {
  const tab = S.view === 'term' ? curTab() : null;
  termsEl.hidden = !tab;
  for (const [id, t] of terms) t.el.classList.toggle('on', !!tab && id === tab.id);
  composer.hidden = !(tab && tab.alive);
  viewEl.className = 'view';

  if (tab) {
    if (tab.alive) {
      viewEl.innerHTML = '';
      requestAnimationFrame(fitActive);
    } else {
      viewEl.className = 'view overlay';
      viewEl.innerHTML = `<div class="closed">
        <div class="txt"><b>Oturum kapalı</b><span>${tab.used ? 'Konuşma kaydedildi, kaldığın yerden devam edebilirsin.' : 'Henüz başlamadı.'}</span></div>
        <button class="primary" data-act="resume">${I.play}<span>${tab.used ? 'Devam et' : 'Başlat'}</span></button></div>`;
    }
    return;
  }
  if (S.view === 'ext') viewEl.innerHTML = extHtml();
  else if (S.view === 'settings') viewEl.innerHTML = settingsHtml();
  else viewEl.innerHTML = newHtml();
}

function newHtml() {
  const def = S.settings.cwd;
  const seen = new Set([def.toLowerCase()]);
  const recent = (S.settings.recent || []).filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase())).slice(0, 7);
  const row = (p, tag) =>
    `<button class="frow" data-cwd="${esc(p)}"><span class="fi">${I.folder}</span><span class="ft"><b>${esc(folderName(p))}</b><span>${esc(p)}</span></span>${tag ? `<span class="tag">${tag}</span>` : ''}</button>`;
  return `<div class="newv">
    <p>Klasörü seçince içinde gerçek Claude Code açılır: izinler, slash komutlar, MCP, her şey çalışır. Mesajını alttaki kutuya ya da doğrudan terminale yazabilirsin.</p>
    ${row(def, 'Varsayılan')}
    ${recent.map((r) => row(r)).join('')}
    <button class="frow other" data-act="pick-new"><span class="fi">${I.plus}</span><span class="ft"><b>Başka klasör…</b><span>Bilgisayardan seç</span></span></button>
  </div>`;
}

function extHtml() {
  const a = S.agents.get(S.ext);
  if (!a) return `<div class="empty-box"><div class="big">${I.grid}</div><h4>Oturum kapandı</h4><p>Bu oturum artık açık değil.</p></div>`;
  const live = a.status === 'running' || a.status === 'waiting';
  return `<div class="extv">
    <dl class="facts">
      <dt>Durum</dt><dd>${STATUS_LABEL[a.status] || a.status}</dd>
      <dt>Şu an</dt><dd>${esc(a.activity || '—')}</dd>
      <dt>Son mesaj</dt><dd>${esc(a.prompt || '—')}</dd>
      <dt>Klasör</dt><dd>${esc(a.cwd)}</dd>
      <dt>Son hareket</dt><dd>${ago(a.updated)} önce</dd>
    </dl>
    <div class="note">${I.eye}<span>Bu oturum Ada dışında (terminal ya da VS Code) çalışıyor. Buradan izleyebilirsin; yazmak için kendi penceresine geç ya da Ada'ya taşı.</span></div>
    ${live ? `<div class="note warn">${I.alert}<span>Oturum şu an açık. Ada'da devam edersen iki yerden aynı anda yazma; önce diğer pencerede kapat.</span></div>` : ''}
    <div><button class="primary" data-act="adopt">${I.play}<span>Ada'da devam et</span></button></div>
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
    <div class="row"><div class="lbl"><b>Üst bar</b><span>Status bar ekranın üstünde yer ayırır; yüzen ada sadece küçük bir hap</span></div>
      ${seg('bar', [['true', 'Status bar', I.bar], ['false', 'Yüzen ada', I.float]])}</div>
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
    <div class="row"><div class="lbl"><b>Kısayol</b><span>Ada penceresini her yerden aç / gizle</span></div><div class="keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd></div></div>
    <div class="row"><div class="lbl"><b>Uygulama</b><span>Pencereyi kapatmak Ada'yı kapatmaz; tamamen çıkmak için</span></div><button class="danger" data-act="quit">${I.power}<span>Ada'dan çık</span></button></div>
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
    Object.assign(tab, await invoke('tab_start', { id: tab.id, cols: t.term.cols, rows: t.term.rows }));
  } catch (e) {
    toast(e);
  }
  renderAll();
  input.focus();
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
  S.settings.recent = [tab.cwd, ...(S.settings.recent || []).filter((r) => r.toLowerCase() !== tab.cwd.toLowerCase())].slice(0, 8);
  return { tab, isNew: true, changed: true };
}

async function newTab(cwd, resume = null) {
  try {
    const { tab } = upsertTab(await invoke('tab_create', { cwd, resume }));
    await startTab(tab);
  } catch (e) {
    toast(e);
  }
}

function selectTab(id) {
  S.selected = id;
  S.view = 'term';
  const a = tabAgent(id);
  if (a?.unread) {
    a.unread = false;
    invoke('agent_read', { id: a.sessionId });
  }
  renderAll();
  setTimeout(() => (curTab()?.alive ? input.focus() : null), 30);
}

function showExt(sid) {
  S.view = 'ext';
  S.ext = sid;
  const a = S.agents.get(sid);
  if (a?.unread) {
    a.unread = false;
    invoke('agent_read', { id: sid });
  }
  renderAll();
}

// Bar ya da bildirimden gelen hedef: oturum id'si ya da sekme id'si.
function goTarget(target) {
  if (!target) return;
  const a = S.agents.get(target);
  if (a?.tab && S.tabs.some((t) => t.id === a.tab)) return selectTab(a.tab);
  if (a) return showExt(target);
  if (S.tabs.some((t) => t.id === target)) selectTab(target);
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
}

async function pickFolder(start) {
  return invoke('pick_folder', { start });
}

async function saveSettings() {
  await invoke('save_settings', { settings: S.settings });
}

// ---------- Mesaj kutusu ----------
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

// Metni terminale yazar, sonra Enter. Çok satırlı mesajda satır sonları Claude'un yeni satırı (ESC CR).
function sendInput() {
  const tab = curTab();
  const text = input.value;
  if (!tab?.alive || !text.trim()) return;
  invoke('pty_write', { id: tab.id, data: text.replace(/\r?\n/g, '\x1b\r') });
  setTimeout(() => invoke('pty_write', { id: tab.id, data: '\r' }), 60);
  input.value = '';
  autosize();
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  } else if (e.key === 'Escape') {
    // Esc mesaj kutusundayken de Claude'a gitsin (işi durdurma, menüyü kapatma).
    const tab = curTab();
    if (tab?.alive) invoke('pty_write', { id: tab.id, data: '\x1b' });
  }
});
input.addEventListener('input', autosize);
$('send').innerHTML = I.up;
$('send').addEventListener('click', sendInput);

// ---------- Tıklamalar ----------
$('logo').innerHTML = `${I.spark}<b>Ada</b>`;
$('btn-new').innerHTML = `${I.plus}<span>Yeni oturum</span>`;
$('btn-settings').innerHTML = `${I.sliders}<span>Ayarlar</span>`;
$('btn-new').addEventListener('click', () => {
  S.view = 'new';
  renderAll();
});
$('btn-settings').addEventListener('click', async () => {
  S.view = 'settings';
  await loadRemote();
  renderAll();
});

document.querySelector('.side').addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) {
    e.stopPropagation();
    return closeTab(x.dataset.close);
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) return selectTab(tab.dataset.tab);
  const sid = e.target.closest('[data-sid]');
  if (sid) return showExt(sid.dataset.sid);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'new') {
    S.view = 'new';
    renderAll();
  } else if (act === 'go-settings') $('btn-settings').click();
});

$('mhead').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="close-tab"]') && S.selected) closeTab(S.selected);
});

viewEl.addEventListener('click', async (e) => {
  const cwd = e.target.closest('[data-cwd]')?.dataset.cwd;
  if (cwd) return newTab(cwd);
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
    await saveSettings();
    return renderBody();
  }
  const remOn = e.target.closest('[data-remon]');
  if (remOn) {
    const r = S.settings.reminders[+remOn.dataset.remon];
    r.on = !r.on;
    await saveSettings();
    return renderBody();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'pick') {
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
  } else if (act === 'adopt') {
    const a = S.agents.get(S.ext);
    if (a) newTab(a.cwd, a.sessionId);
  } else if (act === 'hooks-install' || act === 'hooks-uninstall') {
    try {
      S.hooks = await invoke(act.replace('-', '_'));
    } catch (err) {
      toast(err);
    }
    renderAll();
  } else if (act === 'remote-toggle') {
    try {
      S.remote = await invoke('remote_set', { on: !S.remote?.on });
    } catch (err) {
      toast(err);
      await loadRemote();
    }
    renderAll();
  } else if (act === 'remote-regen') {
    S.remote = await invoke('remote_regen');
    renderBody();
  } else if (act === 'quit') {
    invoke('quit');
  }
});

// ---------- Olaylar ----------
T.event.listen('select', ({ payload }) => goTarget(payload));
T.event.listen('open-settings', () => $('btn-settings').click());
T.event.listen('settings', ({ payload }) => {
  S.settings = payload;
  if (S.view === 'settings') renderBody();
});

T.event.listen('pty', ({ payload }) => terms.get(payload.id)?.term.write(payload.data));
T.event.listen('pty-exit', ({ payload: id }) => {
  const tab = S.tabs.find((t) => t.id === id);
  if (tab) tab.alive = false;
  terms.get(id)?.term.write('\r\n\x1b[90m[oturum kapandı]\x1b[0m\r\n');
  renderAll();
});

// Sekme açıldı, başladı ya da kapandı. Telefondan açılan sekme burada öğrenilir;
// terminali hemen kurulur ki ilk çıktı kaçmasın (görünür olunca fit edilir).
T.event.listen('tab', ({ payload }) => {
  const { tab, isNew, changed } = upsertTab(payload);
  if (isNew) {
    const ref = terms.get(S.selected) || [...terms.values()][0];
    const t = ensureTerm(tab.id);
    if (ref) t.term.resize(ref.term.cols, ref.term.rows);
  }
  if (changed) renderAll();
});

T.event.listen('agent', ({ payload: a }) => {
  if (a.status === 'ended') S.agents.delete(a.sessionId);
  else S.agents.set(a.sessionId, a);
  if (a.tab) {
    const tab = S.tabs.find((t) => t.id === a.tab);
    if (tab && a.status === 'running') tab.used = true;
  }
  const viewing = document.hasFocus() && ((S.view === 'term' && S.selected === a.tab) || (S.view === 'ext' && S.ext === a.sessionId));
  if (viewing && a.unread) {
    a.unread = false;
    invoke('agent_read', { id: a.sessionId });
  }
  renderSide();
  renderHead();
  if (S.view === 'ext' && S.ext === a.sessionId) renderBody();
});
T.event.listen('agent-remove', ({ payload: id }) => {
  S.agents.delete(id);
  renderSide();
});
setInterval(renderSide, 30000); // "x dk önce" yazıları güncel kalsın

// ---------- Başlangıç ----------
(async () => {
  const st = await getState();
  S.settings = st.settings;
  S.tabs = st.tabs;
  S.hooks = st.hooks;
  for (const a of st.agents) S.agents.set(a.sessionId, a);
  await loadRemote();
  S.selected = S.tabs.at(-1)?.id ?? null;
  S.view = S.selected ? 'term' : 'new';
  renderAll();
})();
