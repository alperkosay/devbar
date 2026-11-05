// Ada arayüzü: kapalıyken durum hapı, açıkken oturumlar ve prompt kutusu.
const T = window.__TAURI__;
const invoke = T.core.invoke;
const appWin = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);

const island = $('island');
const peek = $('peek');
const chipsEl = $('chips');
const body = $('body');
const composer = $('composer');
const input = $('input');
const sendBtn = $('send');
const folderBtn = $('folder');
const barRight = $('bar-right');
const toastEl = $('toast');

const PANEL = { w: 580, h: 470 };
const PEEK_H = 34;

const S = {
  settings: { cwd: '', permissionMode: 'acceptEdits', model: '' },
  sessions: [],
  selected: null, // null = yeni oturum
  view: 'chat', // chat | settings
  open: false,
  draftCwd: null,
  picking: false,
  peekW: 150,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const folderName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const cur = () => S.sessions.find((s) => s.id === S.selected) || null;

// ---------- Geometri ----------
let lastHit = '';
function geometry() {
  const w = S.open ? PANEL.w : S.peekW;
  const h = S.open ? PANEL.h : PEEK_H;
  island.style.setProperty('--w', w + 'px');
  island.style.setProperty('--h', h + 'px');
  // Kapalıyken kulaklar ve hover büyümesi için biraz pay bırak.
  const m = S.open ? 0 : 14;
  const hit = { x: (window.innerWidth - w) / 2 - m, y: 0, w: w + 2 * m, h: h + (S.open ? 0 : 6) };
  const key = JSON.stringify(hit);
  if (key !== lastHit) {
    lastHit = key;
    invoke('set_hit', hit);
  }
}

let openedAt = 0;
async function openPanel() {
  if (S.open) return;
  S.open = true;
  openedAt = Date.now();
  // Hap bir oturumu gösteriyorsa (çalışan ya da yeni biten) direkt onu aç.
  const p = peekState();
  if (p.s) {
    S.selected = p.s.id;
    S.view = 'chat';
  }
  island.classList.add('open');
  geometry();
  renderAll();
  await invoke('focus_window');
  setTimeout(() => S.view === 'chat' && input.focus(), 80);
  markRead();
}

// blurred: odak zaten başka uygulamaya geçtiyse geri vermeye gerek yok.
function closePanel(blurred = false) {
  if (!S.open) return;
  S.open = false;
  island.classList.remove('open');
  input.blur();
  renderPeek();
  if (!blurred) invoke('release_focus');
}

// ---------- Kapalı hal ----------
function peekState() {
  const byUpdated = (a, b) => b.updated - a.updated;
  const running = S.sessions.filter((s) => s.status === 'running').sort(byUpdated);
  if (running.length) return { kind: 'running', s: running[0], extra: running.length - 1 };
  const unread = S.sessions.filter((s) => s.unread).sort(byUpdated);
  if (unread.length) return { kind: unread[0].status, s: unread[0], extra: unread.length - 1 };
  return { kind: 'idle' };
}

function renderPeek() {
  const p = peekState();
  if (p.kind === 'idle') {
    const recent = S.sessions.slice(0, 4);
    const dots = recent.map((s) => `<span class="dot ${s.status}"></span>`).join('');
    peek.innerHTML = `<span class="pk-ic accent">${I.spark}</span><span class="pk-title">Ada</span><span class="pk-dots">${dots}</span>`;
    S.peekW = 118 + recent.length * 11;
  } else {
    const icons = { done: I.check, warn: I.alert, error: I.x, idle: I.check };
    const ic = p.kind === 'running' ? '<span class="spin"></span>' : `<span class="pk-ic ${p.kind}">${icons[p.kind] || I.check}</span>`;
    const extra = p.extra > 0 ? `<span class="pk-badge">+${p.extra}</span>` : '';
    peek.innerHTML = `${ic}<span class="pk-text"><b>${esc(folderName(p.s.cwd))}</b><span>${esc(p.s.activity || 'Çalışıyor…')}</span></span>${extra}`;
    S.peekW = 340;
  }
  island.classList.toggle('busy', p.kind === 'running');
  geometry();
}

function flash(status) {
  const cls = status === 'error' ? 'flash-error' : 'flash-done';
  island.classList.remove('flash-done', 'flash-error');
  void island.offsetWidth;
  island.classList.add(cls);
  setTimeout(() => island.classList.remove(cls), 1700);
}

// ---------- Açık hal ----------
function renderAll() {
  renderChips();
  renderBody();
  renderComposer();
}

function renderChips() {
  chipsEl.innerHTML = S.sessions
    .map((s) => {
      const active = s.id === S.selected && S.view === 'chat' ? 'active' : '';
      return `<div class="chip ${active} ${s.unread ? 'unread' : ''}" data-id="${s.id}" title="${esc(s.cwd)}">
        <span class="dot ${s.status}"></span><span class="t">${esc(s.title)}</span>
        <span class="x" data-del="${s.id}" title="Sil">${I.x}</span></div>`;
    })
    .join('');
  $('btn-new').classList.toggle('active', S.selected === null && S.view === 'chat');
  $('btn-settings').classList.toggle('active', S.view === 'settings');
}

function renderBody() {
  if (S.view === 'settings') {
    composer.hidden = true;
    body.innerHTML = settingsHtml();
    return;
  }
  composer.hidden = false;
  const s = cur();
  if (!s) {
    const cwd = S.draftCwd || S.settings.cwd;
    body.innerHTML = `<div class="empty">
      <div class="big">${I.spark}</div>
      <h3>Yeni oturum</h3>
      <p>${esc(folderName(cwd))} klasöründe Claude Code başlar</p>
      <div class="hint"><span><kbd>Enter</kbd> gönder</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> satır</span><span><kbd>Esc</kbd> kapat</span></div>
    </div>`;
    return;
  }
  body.innerHTML = `<div class="stream" id="stream">${s.items.map(itemHtml).join('')}</div>`;
  body.scrollTop = body.scrollHeight;
}

function appendItem(item) {
  const stream = $('stream');
  if (!stream) return renderBody();
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  stream.insertAdjacentHTML('beforeend', itemHtml(item));
  if (nearBottom) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
}

function toolCat(name) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return ['c-edit', I.pen];
  if (/^(Bash|PowerShell|BashOutput|KillShell)$/.test(name)) return ['c-bash', I.terminal];
  if (/^(Grep|Glob)$/.test(name)) return ['c-search', I.search];
  if (name === 'Read') return ['c-read', I.eye];
  if (/^Web/.test(name)) return ['c-web', I.globe];
  if (/^(Task|Agent)$/.test(name)) return ['c-agent', I.bot];
  if (name === 'TodoWrite') return ['c-plan', I.list];
  return ['c-other', I.wrench];
}

function itemHtml(it) {
  switch (it.kind) {
    case 'user':
      return `<div class="msg-user">${esc(it.text)}</div>`;
    case 'text':
      return `<div class="msg-text">${md(it.text)}</div>`;
    case 'tool': {
      const [cls, icon] = toolCat(it.tool);
      return `<div class="tool"><span class="ic ${cls}">${icon}</span><span class="name">${esc(it.tool)}</span><span class="sum">${esc(it.text)}</span></div>`;
    }
    case 'result':
      return `<div class="res">${I.check}<span>${esc(it.text)}</span></div>`;
    case 'warn':
      return `<div class="note warn">${I.alert}<span>${esc(it.text)}</span></div>`;
    case 'error':
      return `<div class="note error">${I.x}<span>${esc(it.text)}</span></div>`;
    default:
      return '';
  }
}

// Küçük markdown: kod blokları, satır içi kod, kalın, başlık, madde.
function md(src) {
  return src
    .split('```')
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const code = nl >= 0 && /^[\w+#.-]*$/.test(part.slice(0, nl).trim()) ? part.slice(nl + 1) : part;
        return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      }
      return esc(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6}\s+(.+)$/gm, '<strong class="h">$1</strong>')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
        .replace(/^\n+|\n+$/g, '')
        .replace(/\n/g, '<br>');
    })
    .join('');
}

function renderComposer() {
  const s = cur();
  const cwd = s ? s.cwd : S.draftCwd || S.settings.cwd;
  folderBtn.innerHTML = `${I.folder}<span>${esc(folderName(cwd))}</span>`;
  folderBtn.title = s ? cwd : `${cwd}\nDeğiştirmek için tıkla`;
  folderBtn.classList.toggle('static', !!s);

  const running = s?.status === 'running';
  let right = '';
  if (running) right += `<span class="live"><span class="spin sm"></span><span>${esc(s.activity || 'Çalışıyor…')}</span></span>`;
  if (s?.claudeId) right += `<button class="mini" data-act="terminal" title="Bu oturuma gerçek terminalde devam et">${I.terminal}<span>Terminal</span></button>`;
  barRight.innerHTML = right;

  sendBtn.innerHTML = running ? I.stop : I.up;
  sendBtn.classList.toggle('stop', running);
  sendBtn.title = running ? 'Durdur' : 'Gönder (Enter)';
  input.placeholder = running ? 'Claude çalışıyor, bitince devam edebilirsin…' : s ? 'Devam et…' : "Claude'a bir iş ver…";
}

function settingsHtml() {
  const st = S.settings;
  const seg = (key, opts) =>
    `<div class="seg">${opts
      .map(([v, l]) => `<button data-set="${key}" data-val="${v}" class="${st[key] === v ? 'on' : ''} ${v === 'bypassPermissions' ? 'danger-on' : ''}">${l}</button>`)
      .join('')}</div>`;
  const permHint = {
    acceptEdits: 'Dosyaları düzenler, izin listende olmayan komutları reddeder',
    plan: 'Sadece okur ve plan çıkarır, değişiklik yapmaz',
    bypassPermissions: 'Hiçbir şey sormadan her şeyi yapar, dikkatli kullan',
  }[st.permissionMode];
  return `<div class="settings">
    <div class="set-head">${I.sliders}<h3>Ayarlar</h3><button class="mini" data-act="back">${I.x}<span>Kapat</span></button></div>
    <div class="row"><div class="lbl"><b>Varsayılan klasör</b><span>Yeni oturumlar burada açılır</span></div>
      <button class="pathbtn" data-act="pick" title="${esc(st.cwd)}">${I.folder}<span>${esc(st.cwd)}</span></button></div>
    <div class="row"><div class="lbl"><b>İzin modu</b><span>${esc(permHint)}</span></div>
      ${seg('permissionMode', [['acceptEdits', 'Düzenleme'], ['plan', 'Plan'], ['bypassPermissions', 'Tam yetki']])}</div>
    <div class="row"><div class="lbl"><b>Model</b><span>Varsayılan, Claude Code ayarını kullanır</span></div>
      ${seg('model', [['', 'Varsayılan'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']])}</div>
    <div class="row"><div class="lbl"><b>Kısayol</b><span>Her yerden aç ve kapat</span></div>
      <div class="keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd></div></div>
    <div class="row"><div class="lbl"><b>Uygulama</b><span>Çalışan oturumlar durdurulur</span></div>
      <button class="danger" data-act="quit">${I.power}<span>Ada'yı kapat</span></button></div>
  </div>`;
}

// ---------- İşlemler ----------
let toastTimer;
function toast(msg) {
  toastEl.textContent = String(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.textContent = ''), 5000);
}

function markRead() {
  const s = cur();
  if (!S.open || !s || !s.unread) return;
  s.unread = false;
  invoke('mark_read', { id: s.id });
  renderPeek();
  renderChips();
}

function select(id) {
  S.selected = id;
  S.view = 'chat';
  renderAll();
  markRead();
  input.focus();
}

async function send() {
  const s = cur();
  if (s?.status === 'running') return;
  const text = input.value.trim();
  if (!text) return;
  try {
    const id = await invoke('send_prompt', { sessionId: s?.id ?? null, prompt: text, cwd: s ? null : S.draftCwd || S.settings.cwd });
    input.value = '';
    autosize();
    S.draftCwd = null;
    S.selected = id;
    renderAll();
  } catch (e) {
    toast(e);
  }
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

async function deleteSession(id) {
  await invoke('delete_session', { id });
  S.sessions = S.sessions.filter((s) => s.id !== id);
  if (S.selected === id) S.selected = null;
  renderAll();
  renderPeek();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ---------- Olaylar ----------
$('btn-new').innerHTML = I.plus;
$('btn-settings').innerHTML = I.sliders;
peek.addEventListener('click', openPanel);
$('btn-new').addEventListener('click', () => select(null));
$('btn-settings').addEventListener('click', () => {
  S.view = S.view === 'settings' ? 'chat' : 'settings';
  renderAll();
});

chipsEl.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) return deleteSession(del.dataset.del);
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

sendBtn.addEventListener('click', () => {
  const s = cur();
  if (s?.status === 'running') invoke('cancel_session', { id: s.id });
  else send();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
input.addEventListener('input', autosize);

folderBtn.addEventListener('click', async () => {
  if (cur()) return;
  const p = await pickFolder(S.draftCwd || S.settings.cwd);
  if (p) {
    S.draftCwd = p;
    renderBody();
    renderComposer();
  }
  input.focus();
});

barRight.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="terminal"]');
  if (btn && cur()) invoke('open_terminal', { id: cur().id }).catch(toast);
});

body.addEventListener('click', async (e) => {
  const set = e.target.closest('[data-set]');
  if (set) {
    S.settings[set.dataset.set] = set.dataset.val;
    await invoke('save_settings', { settings: S.settings });
    return renderBody();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'back') {
    S.view = 'chat';
    renderAll();
  } else if (act === 'pick') {
    const p = await pickFolder(S.settings.cwd);
    if (p) {
      S.settings.cwd = p;
      await invoke('save_settings', { settings: S.settings });
      renderBody();
    }
  } else if (act === 'quit') {
    invoke('quit');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (S.view === 'settings') {
      S.view = 'chat';
      renderAll();
    } else closePanel();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    select(null);
  }
});

T.event.listen('toggle', () => (S.open ? closePanel() : openPanel()));

// WebView odak değişirken anlık "odak kaybı" olayı atabiliyor; kısa bir süre sonra gerçekten
// odak gitmiş mi diye tekrar bak.
appWin.onFocusChanged(({ payload: focused }) => {
  if (focused || !S.open || S.picking) return;
  const wait = Math.max(150, openedAt + 450 - Date.now());
  setTimeout(async () => {
    if (S.open && !S.picking && !(await appWin.isFocused())) closePanel(true);
  }, wait);
});

// Butonlar odak almasın: odak hep prompt kutusunda kalsın, kısayoldaki Space bırakılınca
// odaktaki butona tıklanmış sayılmasın.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button, .chip')) e.preventDefault();
});

T.event.listen('session', ({ payload }) => {
  const { session, item, full } = payload;
  let s = S.sessions.find((x) => x.id === session.id);
  const prev = s?.status;
  if (!s) {
    s = { ...session, items: full ? session.items : [] };
    S.sessions.unshift(s);
  } else {
    const items = full ? session.items : s.items;
    Object.assign(s, session);
    s.items = items;
  }
  if (item) s.items.push(item);

  if (prev === 'running' && s.status !== 'running' && !(S.open && S.selected === s.id)) flash(s.status);
  if (S.open && S.selected === s.id) markRead();

  renderPeek();
  if (!S.open) return;
  renderChips();
  if (S.view === 'chat' && S.selected === s.id) {
    if (item && !full) appendItem(item);
    else renderBody();
    renderComposer();
  }
});

// ---------- Başlangıç ----------
(async () => {
  const st = await invoke('get_state');
  S.settings = st.settings;
  S.sessions = st.sessions;
  renderPeek();
  renderAll();
  await document.fonts.ready;
  await invoke('ready');
})();
