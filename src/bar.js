// Üstteki durum barı: en acil oturum ortada, tüm oturumlar sağda. Tıklayınca ana pencere açılır.
// Hatırlatıcılar ve "uzun iş bitti" bildirimleri de buradan gider (bar hep açık).
const notch = $('notch');
const chipsEl = $('chips');

const S = {
  settings: { bar: true, reminders: [] },
  agents: new Map(),
};

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
  if (p.kind === 'idle') {
    const dots = p.list.slice(0, 6).map((a) => `<span class="dot ${a.status}"></span>`).join('');
    const label = p.list.length ? `${p.list.length} oturum` : 'Hazır';
    notch.innerHTML = `<span class="ic spark">${I.spark}</span><span class="txt"><b>${label}</b></span>${dots ? `<span class="dots">${dots}</span>` : ''}`;
  } else {
    const ic = p.kind === 'running' ? '<span class="spin"></span>' : `<span class="ic ${p.kind}">${p.kind === 'waiting' ? I.bell : I.check}</span>`;
    const more = p.extra > 0 ? `<span class="more">+${p.extra}</span>` : '';
    notch.innerHTML = `${ic}<span class="txt"><b>${esc(p.a.project)}</b><span>${esc(p.a.activity)}</span></span>${more}`;
  }
  notch.dataset.sid = p.a?.sessionId || '';

  chipsEl.innerHTML = p.list
    .slice(0, 8)
    .map(
      (a) =>
        `<button class="chip ${a.status}" data-sid="${esc(a.sessionId)}" title="${esc(a.cwd)}\n${esc(a.activity)}"><span class="dot ${a.status}"></span><b>${esc(a.project)}</b></button>`,
    )
    .join('');

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
$('brand').innerHTML = `${I.spark}<span>Ada</span>`;
$('brand').addEventListener('click', () => invoke('open_app', { target: null }));
// Oturuma tıklayınca altında kart açılır; çift tıklayınca direkt ana pencere.
function pop(el, sid) {
  const r = el.getBoundingClientRect();
  invoke('show_pop', { sid, x: r.left + r.width / 2 });
}
notch.addEventListener('click', () => {
  if (notch.dataset.sid) pop(notch, notch.dataset.sid);
  else invoke('open_app', { target: null });
});
notch.addEventListener('dblclick', () => invoke('open_app', { target: notch.dataset.sid || null }));
chipsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sid]');
  if (b) pop(b, b.dataset.sid);
});
chipsEl.addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-sid]');
  if (b) invoke('open_app', { target: b.dataset.sid });
});

// ---------- Bildirimler ----------
const runStart = new Map(); // sessionId -> çalışmaya başladığı an
const LONG_RUN = 60_000; // 1 dakikadan uzun süren iş bitince bildir

function onAgent(a, prev) {
  if (a.status === 'running' && prev?.status !== 'running') runStart.set(a.sessionId, Date.now());
  if (prev && prev.status !== a.status) {
    if (a.status === 'done' || a.status === 'waiting') flash(a.status);
    const started = runStart.get(a.sessionId);
    if (a.status === 'done' && started && Date.now() - started > LONG_RUN) {
      const min = Math.round((Date.now() - started) / 60000);
      invoke('notify', { title: `${a.project} bitti`, body: `${min} dakika sürdü${a.prompt ? ': ' + a.prompt : ''}` });
    }
    if (a.status === 'waiting') {
      invoke('notify', { title: `${a.project} seni bekliyor`, body: a.activity || 'İzin ya da cevap bekliyor' });
    }
    if (a.status !== 'running') runStart.delete(a.sessionId);
  }
}

// ---------- Hatırlatıcılar ----------
const next = {}; // hatırlatıcı id -> sonraki zaman
const IDLE_RESET = 300; // 5 dk boşta kalınca sayaç baştan

async function checkReminders() {
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
  for (const k of Object.keys(next)) delete next[k];
  checkReminders();
});
T.event.listen('layout', ({ payload: bar }) => setLayout(bar));
setInterval(render, 30000); // 3 saat kuralı ve süreler için

(async () => {
  const st = await getState();
  S.settings = st.settings;
  for (const a of st.agents) S.agents.set(a.sessionId, a);
  setLayout(S.settings.bar);
  await document.fonts.ready;
  render();
  await invoke('ready');
  checkReminders();
})();
