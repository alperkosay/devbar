// Bardan aşağı sarkan çekmece. Görünümler: oturum, Ada menüsü, açık portlar, Docker, git, sistem.
// Odak kaybedince kapanır; menüden açılan görünümlerde geri tuşu menüye döner.
const card = $('card');
const win = T.window.getCurrentWindow();

const P = {
  kind: 'menu',
  id: null,
  fromMenu: false,
  agents: new Map(),
  tabs: [],
  settings: { cwd: '', recent: [] },
  sys: null,
  ports: null,
  showSystem: false,
  docker: undefined,
  git: null,
  top: null,
  armed: null, // kapatılmak üzere olan PID (iki tıkla onay)
  msg: null, // { text, err }
  term: null,
  termTab: null,
};

const gb = (b) => (b / 1024 ** 3).toFixed(1);
const mb = (b) => (b >= 1024 ** 3 ? `${gb(b)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const lvl = (v) => (v >= 90 ? 'hot' : v >= 75 ? 'warm' : '');
const agent = () => P.agents.get(P.id) || null;
// "C:\...\next\dist\bin\next dev" -> "next dev": yol gibi görünen parçaların sadece adı.
const shortCmd = (cmd) =>
  cmd
    .split(' ')
    .map((t) => (/[\\/]/.test(t) ? t.replace(/["']/g, '').split(/[\\/]/).pop().replace(/\.(m?js|cjs|cmd|exe|py)$/i, '') : t))
    .join(' ');
// Docker'ın yayınladığı port -> container (portlar görünümünde Docker satırlarını adlandırmak için).
function dockerByPort() {
  const map = new Map();
  for (const c of P.docker || []) for (const m of c.ports.matchAll(/:(\d+)->/g)) map.set(+m[1], c);
  return map;
}
const tabOf = (a) => (a?.tab ? P.tabs.find((t) => t.id === a.tab) || null : null);

function head(icon, color, title, sub, tools = '') {
  const back = P.fromMenu ? `<button class="back" data-nav="menu" title="Menü">${I.left}</button>` : '';
  return `<div class="sh-head">${back}<span class="ic ${color}">${icon}</span><span class="tt"><b>${title}</b><span>${sub}</span></span>${tools}</div>`;
}

function toastHtml() {
  return P.msg ? `<div class="toast ${P.msg.err ? 'err' : ''}">${esc(P.msg.text)}</div>` : '';
}
function say(text, err = false) {
  P.msg = { text: String(text), err };
  render();
  setTimeout(() => {
    P.msg = null;
    render();
  }, 2500);
}

// Proje klasörleri: varsayılan, son açılanlar ve açık sekmeler.
function projects() {
  const seen = new Set();
  return [P.settings.cwd, ...(P.settings.recent || []), ...P.tabs.map((t) => t.cwd)]
    .filter((d) => d && !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()))
    .slice(0, 6);
}

// ---------- Görünümler ----------
function menuView() {
  const list = sortedAgents(P.agents);
  const waiting = list.filter((a) => a.status === 'waiting').length;
  const s = P.sys;
  const cpu = s ? Math.round(s.cpu) : 0;
  const mem = s?.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  const tile = (nav, icon, color, title, sub) =>
    `<button class="tile" data-nav="${nav}"><span class="ic ${color}">${icon}</span><b>${title}</b><span>${sub}</span></button>`;
  const proj = projects()
    .map(
      (d) => `<div class="row"><span class="ic c-accent" style="width:30px;height:30px;border-radius:9px;display:grid;place-items:center">${I.folder}</span>
      <div class="main"><div class="l1"><b>${esc(folderName(d))}</b></div><div class="l3">${esc(d)}</div></div>
      <div class="acts">
        <button class="act go" data-open="claude" data-path="${esc(d)}" title="Bu klasörde Claude oturumu">${I.spark}</button>
        <button class="act" data-open="code" data-path="${esc(d)}" title="VS Code'da aç">${I.code}</button>
        <button class="act" data-open="terminal" data-path="${esc(d)}" title="Terminalde aç">${I.terminal}</button>
        <button class="act" data-open="folder" data-path="${esc(d)}" title="Klasörü aç">${I.folder}</button>
      </div></div>`,
    )
    .join('');
  return `${head(I.spark, 'c-accent', 'Ada', `${list.length} oturum${waiting ? ` · ${waiting} seni bekliyor` : ''}`)}
    <div class="tiles">
      ${tile('ports', I.plug, 'c-green', 'Açık portlar', s ? `${s.ports} geliştirme portu` : 'Bakılıyor…')}
      ${tile('docker', I.box, 'c-sky', 'Docker', s?.docker == null ? 'Çalışmıyor' : `${s.docker} container`)}
      ${tile('git', I.branch, 'c-pink', 'Git', s ? (s.git ? `${s.git} repoda değişiklik` : 'Her şey temiz') : 'Bakılıyor…')}
      ${tile('sys', I.cpu, 'c-amber', 'Sistem', s ? `CPU ${cpu}% · RAM ${mem}%` : 'Bakılıyor…')}
    </div>
    <div class="sec">Projeler</div>
    <div class="list">${proj || '<div class="empty">Henüz proje yok</div>'}</div>
    <div class="sec">Hızlı araçlar</div>
    <div class="chips">
      <button class="chipb" data-tool="uuid">${I.hash}UUID kopyala</button>
      <button class="chipb" data-tool="unix">${I.clock}Unix zaman</button>
      <button class="chipb" data-tool="iso">${I.clock}ISO tarih</button>
      <button class="chipb" data-tool="localhost">${I.ext}localhost:3000</button>
    </div>
    ${toastHtml()}
    <div class="foot">
      <button class="tool" data-app="open">${I.grid}Ada penceresi</button>
      <button class="tool" data-app="settings">${I.sliders}Ayarlar</button>
      <button class="tool quit" data-app="quit">${I.power}Çıkış</button>
    </div>`;
}

function portsView() {
  const all = P.ports;
  const list = all ? all.filter((p) => P.showSystem || !p.system) : null;
  const hidden = all ? all.filter((p) => p.system).length : 0;
  const devCount = all ? all.filter((p) => p.dev).length : 0;
  const tools = `<button class="tool ${P.showSystem ? 'on' : ''}" data-toggle="system" title="Windows servislerinin portları">${P.showSystem ? 'Sistem dahil' : `+${hidden} sistem`}</button>
    <button class="tool" data-refresh="ports" title="Yenile">${I.refresh}</button>`;
  let group = null;
  const dmap = dockerByPort();
  const rows = (list || [])
    .map((p) => {
      const box = p.kind === 'Docker' ? dmap.get(p.port) : null;
      // Gruplar: geliştirme, diğer uygulamalar, Windows servisleri.
      const g = p.system ? 'Windows servisleri' : p.dev ? 'Geliştirme' : 'Diğer uygulamalar';
      const sec = g !== group ? `<div class="sec">${g}</div>` : '';
      group = g;
      const title = box ? box.name : p.project || p.name;
      const cmd = box ? `${box.image}${box.project ? ' · ' + box.project : ''}` : shortCmd(p.cmd);
      const armed = P.armed === p.pid;
      return `${sec}<div class="row ${p.system || !p.dev ? 'sysp' : ''}">
        <span class="pnum" data-copy="http://localhost:${p.port}" title="Adresi kopyala">:${p.port}</span>
        <div class="main">
          <div class="l1"><b>${esc(title)}</b>${p.kind ? `<span class="badge k-${esc(p.kind)}">${esc(p.kind)}</span>` : ''}</div>
          ${cmd ? `<div class="l2" title="${esc(p.cmd)}">${esc(cmd)}</div>` : ''}
          <div class="l3" title="${esc(p.cwd)}">${esc(p.name)} · PID ${p.pid} · ${esc(p.addr)}${p.cwd ? ' · ' + esc(p.cwd) : ''}</div>
        </div>
        <div class="acts">
          <button class="act go" data-url="http://localhost:${p.port}" title="Tarayıcıda aç">${I.ext}</button>
          ${p.cwd ? `<button class="act" data-open="code" data-path="${esc(p.cwd)}" title="Projeyi VS Code'da aç">${I.code}</button>` : ''}
          <button class="act kill ${armed ? 'armed' : ''}" data-kill="${p.pid}" title="Süreci kapat">${armed ? 'Emin misin?' : I.x}</button>
        </div></div>`;
    })
    .join('');
  return `${head(I.plug, 'c-green', 'Açık portlar', list ? `${devCount} geliştirme, ${list.length - devCount} diğer` : 'Bakılıyor…', tools)}
    <div class="list">${list ? rows || '<div class="empty">Dinleyen geliştirme portu yok</div>' : '<div class="empty">Bakılıyor…</div>'}</div>
    ${toastHtml()}`;
}

function dockerView() {
  const c = P.docker;
  let body;
  if (c === undefined) body = '<div class="empty">Bakılıyor…</div>';
  else if (c === null) body = '<div class="empty">Docker çalışmıyor ya da kurulu değil.</div>';
  else if (!c.length) body = '<div class="empty">Çalışan container yok.</div>';
  else
    body = c
      .map((x) => {
        const hostPorts = [...x.ports.matchAll(/:(\d+)->/g)].map((m) => m[1]);
        const uniq = [...new Set(hostPorts)];
        return `<div class="row">
          <span class="ic c-sky" style="width:30px;height:30px;border-radius:9px;display:grid;place-items:center">${I.box}</span>
          <div class="main">
            <div class="l1"><b>${esc(x.name)}</b>${x.project ? `<span class="badge">${esc(x.project)}</span>` : ''}</div>
            <div class="l2">${esc(x.image)}</div>
            <div class="l3">${esc(x.status)}${x.ports ? ' · ' + esc(x.ports) : ''}</div>
          </div>
          <div class="acts">${uniq.map((p) => `<button class="act go" data-url="http://localhost:${p}" title="localhost:${p} aç">${I.ext}</button>`).join('')}</div>
        </div>`;
      })
      .join('');
  return `${head(I.box, 'c-sky', 'Docker', Array.isArray(c) ? `${c.length} container çalışıyor` : 'Container durumu', `<button class="tool" data-refresh="docker">${I.refresh}</button>`)}
    <div class="list">${body}</div>${toastHtml()}`;
}

function gitView() {
  const r = P.git;
  const rows = (r || [])
    .sort((a, b) => b.changes + b.ahead - (a.changes + a.ahead))
    .map(
      (x) => `<div class="row">
        <span class="ic c-pink" style="width:30px;height:30px;border-radius:9px;display:grid;place-items:center">${I.branch}</span>
        <div class="main">
          <div class="l1"><b>${esc(x.name)}</b><span class="br">${I.branch}${esc(x.branch)}</span></div>
          <div class="l2">${x.changes ? `<span class="chg">${x.changes} değişiklik</span>` : '<span class="clean">temiz</span>'}${x.ahead ? ` · <span class="sync">↑${x.ahead} gönderilmemiş</span>` : ''}${x.behind ? ` · <span class="sync">↓${x.behind} geride</span>` : ''}</div>
          <div class="l3">${esc(x.path)}</div>
        </div>
        <div class="acts">
          <button class="act go" data-open="claude" data-path="${esc(x.path)}" title="Claude ile bak">${I.spark}</button>
          <button class="act" data-open="code" data-path="${esc(x.path)}" title="VS Code'da aç">${I.code}</button>
          <button class="act" data-open="terminal" data-path="${esc(x.path)}" title="Terminalde aç">${I.terminal}</button>
        </div></div>`,
    )
    .join('');
  const dirty = (r || []).filter((x) => x.changes || x.ahead || x.behind).length;
  return `${head(I.branch, 'c-pink', 'Git durumu', r ? `${r.length} repo · ${dirty} tanesinde değişiklik` : 'Bakılıyor…', `<button class="tool" data-refresh="git">${I.refresh}</button>`)}
    <div class="list">${r ? rows || '<div class="empty">Son projelerde git reposu yok</div>' : '<div class="empty">Bakılıyor…</div>'}</div>${toastHtml()}`;
}

function sysView() {
  const s = P.sys;
  const cpu = s ? Math.round(s.cpu) : 0;
  const mem = s?.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  const meter = (icon, label, val, text) =>
    `<div class="meter"><div class="top">${icon}<b>${label}</b><span>${text}</span></div><div class="bar-o"><div class="bar-i ${lvl(val)}" style="width:${val}%"></div></div></div>`;
  const procs = (P.top || []).map(([n, m, c]) => `<div class="proc"><b>${esc(n)}${c > 1 ? ` <span>×${c}</span>` : ''}</b><span>${mb(m)}</span></div>`).join('');
  return `${head(I.cpu, 'c-amber', 'Sistem', 'Canlı kullanım')}
    ${meter(I.cpu, 'İşlemci', cpu, `${cpu}%`)}
    ${meter(I.mem, 'Bellek', mem, s ? `${gb(s.memUsed)} / ${gb(s.memTotal)} GB` : '…')}
    <div class="sec">En çok bellek kullananlar</div>
    <div class="procs">${procs || '<div class="empty">Bakılıyor…</div>'}</div>`;
}

// ---------- Oturum ----------
async function attachTerm(tab) {
  P.term?.dispose();
  P.term = null;
  P.termTab = null;
  if (!tab?.alive) return;
  const scr = await invoke('tab_screen', { id: tab.id });
  P.term = new Terminal({ cols: scr?.cols || 110, rows: scr?.rows || 32, scrollback: 200, allowProposedApi: true });
  P.termTab = tab.id;
  if (scr?.data) await new Promise((r) => P.term.write(scr.data, r));
}

// Claude ekranındaki boşlukları, giriş kutusu çizgilerini ve alt bilgiyi at; konuşma ve menü kalsın.
function screenLines() {
  if (!P.term) return '';
  const b = P.term.buffer.active;
  const lines = [];
  for (let i = b.baseY; i < b.baseY + P.term.rows; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  return lines
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─━│╭╮╰╯]+$/.test(l) && !/^\s*[❯>]\s*$/.test(l) && !/shift\+tab to cycle|\? for shortcuts/.test(l))
    .slice(-20)
    .join('\n');
}

function sessionView() {
  const a = agent();
  if (!a) return `<div class="hd"><b>Oturum kapandı</b></div>`;
  const tab = tabOf(a);
  const live = !!tab?.alive;
  const icon = a.status === 'waiting' ? I.bell : a.status === 'running' ? I.wrench : a.status === 'done' ? I.check : I.spark;
  const screen = live ? screenLines() : '';
  return `
    <div class="hd"><span class="dot ${a.status}"></span><b>${esc(a.project)}</b><span class="pill ${a.status}">${STATUS_LABEL[a.status] || a.status}</span><span class="when">${ago(a.updated)}</span></div>
    <div class="sub">${esc(a.cwd)}</div>
    <div class="actline ${a.status}">${icon}<span>${esc(a.activity || '—')}</span></div>
    ${a.prompt ? `<div class="prompt">${esc(a.prompt)}</div>` : ''}
    ${screen ? `<pre class="screen" id="screen">${esc(screen)}</pre>` : ''}
    ${
      live && a.status === 'waiting'
        ? `<div class="quick">
            <button class="yes" data-key="1">${I.check}Evet <kbd>1</kbd></button>
            <button class="always" data-key="2">Hep evet <kbd>2</kbd></button>
            <button class="no" data-key="esc">${I.x}Hayır <kbd>Esc</kbd></button></div>`
        : ''
    }
    ${live ? `<div class="reply"><input id="reply" placeholder="Hızlı yanıt yaz, Enter ile gönder" spellcheck="false"><button id="send" title="Gönder">${I.up}</button></div>` : ''}
    <div class="ft">
      <span class="note">${tab ? (live ? 'Ada oturumu' : 'Ada oturumu · kapalı') : 'Terminal ya da VS Code oturumu, buradan sadece izlenir'}</span>
      <button class="open" data-app="open-session">${I.grid}Pencerede aç</button>
    </div>`;
}

// ---------- Çizim ----------
const VIEWS = { menu: menuView, ports: portsView, docker: dockerView, git: gitView, sys: sysView, session: sessionView };

function render() {
  // Yanıt yazılırken oturum kartını baştan çizme.
  const typing = document.activeElement?.id === 'reply' && document.activeElement.value;
  if (typing) return;
  card.innerHTML = (VIEWS[P.kind] || menuView)();
  fit();
}

// Çekmece genişlikleri (bar.js ile aynı).
const SHEET = { session: 640, menu: 420, ports: 700, docker: 640, git: 580, sys: 440 };

let lastH = 0;
function fit() {
  requestAnimationFrame(() => {
    const scr = $('screen');
    if (scr) scr.scrollTop = scr.scrollHeight;
    const h = Math.ceil(card.getBoundingClientRect().height + 22);
    if (Math.abs(h - lastH) > 1) {
      lastH = h;
      invoke('pop_size', { h, w: SHEET[P.kind] || 420 });
    }
  });
}

let lineTimer;
function refreshScreen() {
  clearTimeout(lineTimer);
  lineTimer = setTimeout(() => {
    const el = $('screen');
    if (el) {
      el.textContent = screenLines();
      fit();
    } else render();
  }, 120);
}

// Görünümün verisini çek.
async function load(kind) {
  try {
    if (kind === 'ports') {
      if (P.docker === undefined) P.docker = await invoke('sys_docker');
      P.ports = await invoke('sys_ports');
    }
    else if (kind === 'docker') P.docker = await invoke('sys_docker');
    else if (kind === 'git') P.git = await invoke('sys_git');
    else if (kind === 'sys') P.top = await invoke('sys_top');
  } catch (e) {
    say(e, true);
  }
  if (P.kind === kind) render();
}

let liveTimer;
function go(kind, fromMenu = P.fromMenu) {
  P.kind = kind;
  P.fromMenu = fromMenu && kind !== 'menu';
  P.armed = null;
  lastH = 0;
  render();
  load(kind);
  clearInterval(liveTimer);
  if (kind === 'ports' || kind === 'sys') liveTimer = setInterval(() => load(kind), 3000);
}

function hide() {
  clearInterval(liveTimer);
  invoke('hide_pop');
}

function sendText(text) {
  const tab = tabOf(agent());
  if (!tab?.alive || !text.trim()) return;
  invoke('pty_write', { id: tab.id, data: text.replace(/\r?\n/g, '\x1b\r') });
  setTimeout(() => invoke('pty_write', { id: tab.id, data: '\r' }), 60);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    say(`${label || text} kopyalandı`);
  } catch {
    say('Kopyalanamadı', true);
  }
}

// ---------- Tıklamalar ----------
card.addEventListener('click', async (e) => {
  const t = (sel) => e.target.closest(sel);
  let el;
  if ((el = t('[data-nav]'))) return go(el.dataset.nav, el.dataset.nav !== 'menu');
  if ((el = t('[data-refresh]'))) return load(el.dataset.refresh);
  if ((el = t('[data-toggle="system"]'))) {
    P.showSystem = !P.showSystem;
    return render();
  }
  if ((el = t('[data-copy]'))) return copy(el.dataset.copy);
  if ((el = t('[data-url]'))) {
    invoke('sys_open_url', { url: el.dataset.url }).catch((err) => say(err, true));
    return hide();
  }
  if ((el = t('[data-kill]'))) {
    const pid = +el.dataset.kill;
    if (P.armed !== pid) {
      P.armed = pid;
      return render();
    }
    P.armed = null;
    try {
      await invoke('sys_kill', { pid });
      say(`PID ${pid} kapatıldı`);
    } catch (err) {
      say(err, true);
    }
    return load('ports');
  }
  if ((el = t('[data-open]'))) {
    const { open, path } = el.dataset;
    if (open === 'claude') invoke('new_session', { cwd: path });
    else invoke('sys_open_path', { kind: open, path }).catch((err) => say(err, true));
    return hide();
  }
  if ((el = t('[data-tool]'))) {
    const k = el.dataset.tool;
    if (k === 'uuid') return copy(crypto.randomUUID(), 'UUID');
    if (k === 'unix') return copy(String(Math.floor(Date.now() / 1000)), 'Unix zaman');
    if (k === 'iso') return copy(new Date().toISOString(), 'ISO tarih');
    if (k === 'localhost') {
      invoke('sys_open_url', { url: 'http://localhost:3000' });
      return hide();
    }
  }
  if ((el = t('[data-app]'))) {
    const k = el.dataset.app;
    if (k === 'open') invoke('open_app', { target: null });
    else if (k === 'open-session') invoke('open_app', { target: P.id });
    else if (k === 'settings') {
      await invoke('open_app', { target: null });
      T.event.emitTo('app', 'open-settings');
    } else if (k === 'quit') invoke('quit');
    return hide();
  }
  // Oturum kartı: izin cevabı ve hızlı yanıt.
  const tab = tabOf(agent());
  if ((el = t('[data-key]')) && tab) {
    invoke('pty_write', { id: tab.id, data: el.dataset.key === 'esc' ? '\x1b' : el.dataset.key });
    return;
  }
  if (t('#send')) {
    const inp = $('reply');
    sendText(inp.value);
    inp.value = '';
  }
});
card.addEventListener('keydown', (e) => {
  if (e.target.id === 'reply' && e.key === 'Enter' && !e.isComposing) {
    sendText(e.target.value);
    e.target.value = '';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hide();
});
win.onFocusChanged(({ payload: focused }) => {
  if (!focused) hide();
});

// ---------- Olaylar ----------
T.event.listen('pop-show', async ({ payload }) => {
  card.classList.remove('in');
  const st = await getState();
  P.agents = new Map(st.agents.map((a) => [a.sessionId, a]));
  P.tabs = st.tabs;
  P.settings = st.settings;
  P.id = payload.id;
  if (payload.kind === 'session') await attachTerm(tabOf(agent()));
  go(payload.kind, false);
  void card.offsetWidth;
  card.classList.add('in');
  setTimeout(() => $('reply')?.focus(), 60);
});

T.event.listen('sys', ({ payload }) => {
  P.sys = payload;
  if (P.kind === 'menu' || P.kind === 'sys') render();
});
T.event.listen('agent', ({ payload: a }) => {
  if (a.status === 'ended') P.agents.delete(a.sessionId);
  else P.agents.set(a.sessionId, a);
  if (P.kind === 'session' && a.sessionId === P.id) render();
});
T.event.listen('tab', ({ payload: t }) => {
  const i = P.tabs.findIndex((x) => x.id === t.id);
  if (i >= 0) P.tabs[i] = t;
  else P.tabs.push(t);
});
T.event.listen('pty', ({ payload }) => {
  if (P.term && payload.id === P.termTab) {
    P.term.write(payload.data);
    if (P.kind === 'session') refreshScreen();
  }
});
