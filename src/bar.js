// Üstteki durum barı. Solda DevBar menüsü ve geliştirici göstergeleri (portlar, Docker, git,
// CPU/RAM), ortada en acil oturum, sağda tüm oturumlar. Her öğeye tıklayınca bardan aşağı
// bir çekmece açılır. Hatırlatıcılar ve "uzun iş bitti" bildirimleri de buradan gider.
const notch = $('notch');
// Her ekranda bir bar var; bildirimleri yalnızca ana ekrandaki gönderir (çift gelmesin).
const PRIMARY = T.window.getCurrentWindow().label === 'bar';
const chipsEl = $('chips');
const indsEl = $('inds');

const S = {
  settings: { bar: true, reminders: [] },
  agents: new Map(),
  sys: null, // arka uçtan gelen özet: cpu, mem, port, docker, git
  openKey: '', // açık çekmecenin anahtarı (barda vurgulanır)
};

// Çekmece genişlikleri (mantıksal piksel).
const SHEET = { session: 640, menu: 420, ports: 700, docker: 640, git: 580, sys: 440, new: 480 };
const extrasEl = $('extras');

// Saniyedeki bayt: 1.2M, 340K, 12B
const rate = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + 'M' : b >= 1e3 ? Math.round(b / 1e3) + 'K' : b + 'B');

// Sağ uç: ağ hızı, yerel IP (tıkla kopyala), telefon erişimi, yeni oturum.
let ipCopied = false;
function renderExtras() {
  const s = S.sys;
  let html = '<span class="sep"></span>';
  if (s) {
    html += `<button class="ind net" data-kind="sys" data-key="sys:" title="Ağ: indirme / yükleme (saniyede)"><i>↓</i><b class="dn">${rate(s.netRx)}</b><i>↑</i><b class="up">${rate(s.netTx)}</b></button>`;
    if (s.ip)
      html += `<button class="ind ip ${ipCopied ? 'copied' : ''}" data-ip="${esc(s.ip)}" title="Yerel IP, tıkla kopyala (telefonda denemek için)">${I.globe}<b>${ipCopied ? 'Kopyalandı' : esc(s.ip)}</b></button>`;
    if (s.phone) html += `<button class="ind phone" data-phone title="Telefon erişimi açık">${I.phone}</button>`;
  }
  html += `<button class="newbtn" data-new data-key="new:" title="Yeni Claude oturumu">${I.plus}Oturum</button>`;
  extrasEl.innerHTML = html;
  markOpen();
}
extrasEl.addEventListener('click', async (e) => {
  let b;
  if ((b = e.target.closest('[data-kind]'))) return openSheet(b.dataset.kind, null, b, 'right');
  if ((b = e.target.closest('[data-new]'))) return openSheet('new', null, b, 'right');
  if ((b = e.target.closest('[data-ip]'))) {
    try {
      await navigator.clipboard.writeText(b.dataset.ip);
      ipCopied = true;
      renderExtras();
      setTimeout(() => {
        ipCopied = false;
        renderExtras();
      }, 1400);
    } catch {}
    return;
  }
  if (e.target.closest('[data-phone]')) {
    await invoke('open_app', { target: null });
    T.event.emitTo('app', 'open-settings');
  }
});
const EDGE = 12; // çekmece penceresinin gölge payı

function openSheet(kind, id, el, align = 'left') {
  const r = el.getBoundingClientRect();
  const w = SHEET[kind];
  const left = align === 'right' ? r.right - w + EDGE : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left - EDGE;
  invoke('show_pop', { kind, id: id ?? null, left, w });
}

function markOpen() {
  document.querySelectorAll('[data-key]').forEach((el) => el.classList.toggle('open', el.dataset.key === S.openKey));
}

function renderInds() {
  const s = S.sys;
  if (!s) return (indsEl.innerHTML = '');
  const mem = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  const cpu = Math.round(s.cpu);
  const lvl = (v) => (v >= 90 ? 'hot' : v >= 75 ? 'warm' : '');
  const gb = (b) => (b / 1024 ** 3).toFixed(1);
  let html = `<button class="ind ports" data-kind="ports" data-key="ports:" title="Açık portlar">${I.plug}<b>${s.ports}</b><span>port</span></button>`;
  if (s.docker !== null && s.docker !== undefined)
    html += `<button class="ind docker" data-kind="docker" data-key="docker:" title="Docker">${I.box}<b>${s.docker}</b><span>container</span></button>`;
  if (s.git > 0) html += `<button class="ind git" data-kind="git" data-key="git:" title="Değişikliği olan repolar">${I.branch}<b>${s.git}</b><span>repo</span></button>`;
  html += `<span class="sep"></span>
    <button class="ind sys ${lvl(cpu)}" data-kind="sys" data-key="sys:" title="İşlemci">${I.cpu}<b>${cpu}%</b></button>
    <button class="ind sys ${lvl(mem)}" data-kind="sys" data-key="sys:" title="Bellek: ${gb(s.memUsed)} / ${gb(s.memTotal)} GB">${I.mem}<b>${mem}%</b></button>`;
  indsEl.innerHTML = html;
  markOpen();
}

function peekState() {
  const list = sortedAgents(S.agents);
  for (const kind of ['waiting', 'running']) {
    const xs = list.filter((a) => a.status === kind);
    if (xs.length) return { kind, a: xs[0], extra: xs.length - 1, list };
  }
  const un = list.filter((a) => a.unread && a.status === 'done');
  if (un.length) return { kind: 'done', a: un[0], extra: un.length - 1, list };
  return { kind: 'idle', list };
}

let lastSize = '';
function render() {
  const p = peekState();
  notch.classList.toggle('busy', p.kind === 'running');
  notch.classList.toggle('waiting', p.kind === 'waiting');
  notch.classList.toggle('done', p.kind === 'done');
  if (p.kind === 'idle') {
    const dots = p.list.slice(0, 6).map((a) => `<span class="dot ${a.status}"></span>`).join('');
    const label = p.list.length ? `${p.list.length} oturum` : 'Hazır';
    notch.innerHTML = `<span class="ic spark">${I.spark}</span><span class="txt"><b>${label}</b></span>${dots ? `<span class="dots">${dots}</span>` : ''}`;
  } else {
    const ic = p.kind === 'running' ? '<span class="spin"></span>' : `<span class="ic ${p.kind}">${p.kind === 'waiting' ? I.bell : I.check}</span>`;
    const more = p.extra > 0 ? `<span class="more">+${p.extra}</span>` : '';
    notch.innerHTML = `${ic}<span class="txt"><b>${esc(nameOf(p.a))}</b><span>${esc(p.a.activity)}</span></span>${more}`;
  }
  notch.dataset.sid = p.a?.sessionId || '';

  chipsEl.innerHTML = p.list
    .slice(0, 8)
    .map(
      (a) =>
        `<button class="chip ${a.status}" data-sid="${esc(a.sessionId)}" data-key="session:${esc(a.sessionId)}" title="${esc(a.cwd)}\n${esc(a.activity)}"><span class="dot ${a.status}"></span><b>${esc(nameOf(a))}</b></button>`,
    )
    .join('');
  notch.dataset.key = p.a ? `session:${p.a.sessionId}` : 'menu:';
  markOpen();

  // Yüzen ada modunda pencere hap boyunda olsun.
  if (!S.settings.bar) {
    const r = notch.getBoundingClientRect();
    const size = `${Math.ceil(r.width + 24)}x34`;
    if (size !== lastSize) {
      lastSize = size;
      invoke('bar_size', { w: Math.ceil(r.width + 24), h: 34 });
    }
  }
}

function flash(kind) {
  const cls = kind === 'waiting' ? 'flash-waiting' : 'flash-done';
  notch.classList.remove('flash-done', 'flash-waiting');
  void notch.offsetWidth;
  notch.classList.add(cls);
  setTimeout(() => notch.classList.remove(cls), 1700);
}

function setLayout(bar) {
  S.settings.bar = bar;
  document.body.classList.toggle('float', !bar);
  lastSize = '';
  render();
}

// ---------- Tıklamalar ----------
$('brand').innerHTML = `${I.spark}<span>DevBar</span>${I.down}`;
$('brand').addEventListener('click', (e) => openSheet('menu', null, e.currentTarget));
$('brand').addEventListener('dblclick', () => invoke('open_app', { target: null }));
indsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (b) openSheet(b.dataset.kind, null, b);
});
// Oturuma tıklayınca altında kart açılır; çift tıklayınca direkt ana pencere.
function pop(el, sid, align) {
  openSheet('session', sid, el, align);
}
notch.addEventListener('click', () => {
  if (notch.dataset.sid) pop(notch, notch.dataset.sid, 'center');
  else openSheet('menu', null, notch, 'center');
});
notch.addEventListener('dblclick', () => invoke('open_app', { target: notch.dataset.sid || null }));
chipsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sid]');
  if (b) pop(b, b.dataset.sid, 'right');
});
chipsEl.addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-sid]');
  if (b) invoke('open_app', { target: b.dataset.sid });
});

// ---------- Bildirimler ----------
const runStart = new Map(); // sessionId -> çalışmaya başladığı an
const LONG_RUN = 60_000; // 1 dakikadan uzun süren iş bitince bildir

function onAgent(a, prev) {
  if (!PRIMARY) {
    if (prev && prev.status !== a.status && (a.status === 'done' || a.status === 'waiting')) flash(a.status);
    return;
  }
  if (a.status === 'running' && prev?.status !== 'running') runStart.set(a.sessionId, Date.now());
  if (prev && prev.status !== a.status) {
    if (a.status === 'done' || a.status === 'waiting') flash(a.status);
    const started = runStart.get(a.sessionId);
    if (a.status === 'done' && started && Date.now() - started > LONG_RUN) {
      const min = Math.round((Date.now() - started) / 60000);
      invoke('notify', { title: `${nameOf(a)} bitti`, body: `${min} dakika sürdü${a.prompt ? ': ' + a.prompt : ''}` });
    }
    if (a.status === 'waiting') {
      invoke('notify', { title: `${nameOf(a)} seni bekliyor`, body: a.activity || 'İzin ya da cevap bekliyor' });
    }
    if (a.status !== 'running') runStart.delete(a.sessionId);
  }
}

// ---------- Hatırlatıcılar ----------
const next = {}; // hatırlatıcı id -> sonraki zaman
const IDLE_RESET = 300; // 5 dk boşta kalınca sayaç baştan

async function checkReminders() {
  if (!PRIMARY) return;
  let idle = 0;
  try {
    idle = await invoke('idle_seconds');
  } catch {}
  const now = Date.now();
  for (const r of S.settings.reminders || []) {
    if (!r.on) {
      delete next[r.id];
      continue;
    }
    if (!next[r.id] || idle > IDLE_RESET) next[r.id] = now + r.minutes * 60000;
    else if (now >= next[r.id]) {
      invoke('notify', { title: r.text, body: `${r.minutes} dakikada bir hatırlatıyorum` });
      next[r.id] = now + r.minutes * 60000;
    }
  }
}
setInterval(checkReminders, 15000);

// ---------- Olaylar ----------
T.event.listen('agent', ({ payload: a }) => {
  const prev = S.agents.get(a.sessionId);
  if (a.status === 'ended') S.agents.delete(a.sessionId);
  else S.agents.set(a.sessionId, a);
  onAgent(a, prev);
  render();
});
T.event.listen('agent-remove', ({ payload: id }) => {
  S.agents.delete(id);
  render();
});
T.event.listen('settings', ({ payload }) => {
  S.settings = payload;
  applyTheme(payload.theme);
  for (const k of Object.keys(next)) delete next[k];
  checkReminders();
});
T.event.listen('layout', ({ payload: bar }) => setLayout(bar));
T.event.listen('sys', ({ payload }) => {
  S.sys = payload;
  renderInds();
  renderExtras();
});
T.event.listen('pop-open', ({ payload }) => {
  S.openKey = payload;
  markOpen();
});
T.event.listen('pop-close', () => {
  S.openKey = '';
  markOpen();
});
setInterval(render, 30000); // 3 saat kuralı ve süreler için

(async () => {
  const st = await getState();
  S.settings = st.settings;
  for (const a of st.agents) S.agents.set(a.sessionId, a);
  applyTheme(S.settings.theme);
  setLayout(S.settings.bar);
  renderExtras();
  await document.fonts.ready;
  render();
  await invoke('ready');
  checkReminders();
})();
