// Bardaki oturuma tıklayınca altında açılan kart: durum, terminalin son satırları,
// izin sorusuna hızlı cevap ve kısa yanıt. Odak kaybedince kapanır.
const card = $('card');
const win = T.window.getCurrentWindow();

const P = {
  sid: null,
  agents: new Map(),
  tabs: [],
  term: null, // ekran satırlarını çözmek için görünmez xterm
  termTab: null,
};

const agent = () => P.agents.get(P.sid) || null;
const tabOf = (a) => (a?.tab ? P.tabs.find((t) => t.id === a.tab) || null : null);

// Görünmez terminal: sekmenin ham çıktısını işleyip ekranda ne yazdığını satır satır verir.
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

function screenLines() {
  if (!P.term) return '';
  const b = P.term.buffer.active;
  const lines = [];
  for (let i = b.baseY; i < b.baseY + P.term.rows; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  // Claude ekranındaki boşlukları, giriş kutusu çizgilerini ve alt bilgi satırını at;
  // geriye konuşma ve (varsa) izin menüsü kalsın.
  const useful = lines
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─━│╭╮╰╯]+$/.test(l) && !/^\s*[❯>]\s*$/.test(l) && !/shift\+tab to cycle|\? for shortcuts/.test(l));
  return useful.slice(-12).join('\n');
}

function render() {
  const a = agent();
  if (!a) {
    card.innerHTML = `<div class="hd"><b>Oturum kapandı</b></div>`;
    return fit();
  }
  const tab = tabOf(a);
  const live = !!tab?.alive;
  const icon = a.status === 'waiting' ? I.bell : a.status === 'running' ? I.wrench : a.status === 'done' ? I.check : I.spark;
  const screen = live ? screenLines() : '';
  card.innerHTML = `
    <div class="hd"><span class="dot ${a.status}"></span><b>${esc(a.project)}</b><span class="pill ${a.status}">${STATUS_LABEL[a.status] || a.status}</span><span class="when">${ago(a.updated)}</span></div>
    <div class="sub">${esc(a.cwd)}</div>
    <div class="act ${a.status}">${icon}<span>${esc(a.activity || '—')}</span></div>
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
      <button class="open" data-act="open">${I.grid}Pencerede aç</button>
    </div>`;
  fit();
}

// Sadece ekran kutusunu güncelle (yazı yazılırken yanıt kutusu bozulmasın).
let lineTimer;
function refreshScreen() {
  clearTimeout(lineTimer);
  lineTimer = setTimeout(() => {
    const el = $('screen');
    const text = screenLines();
    if (el) el.textContent = text;
    else if (text) render();
    fit();
  }, 120);
}

let lastH = 0;
function fit() {
  requestAnimationFrame(() => {
    // Terminal kutusu taşarsa en yeni satırlar görünsün.
    const scr = $('screen');
    if (scr) scr.scrollTop = scr.scrollHeight;
    const h = Math.ceil(card.getBoundingClientRect().height + 18);
    if (Math.abs(h - lastH) > 1) {
      lastH = h;
      invoke('pop_size', { h });
    }
  });
}

function sendText(text) {
  const tab = tabOf(agent());
  if (!tab?.alive || !text.trim()) return;
  invoke('pty_write', { id: tab.id, data: text.replace(/\r?\n/g, '\x1b\r') });
  setTimeout(() => invoke('pty_write', { id: tab.id, data: '\r' }), 60);
}

function hide() {
  invoke('hide_pop');
}

// ---------- Olaylar ----------
card.addEventListener('click', (e) => {
  const tab = tabOf(agent());
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (key && tab) {
    invoke('pty_write', { id: tab.id, data: key === 'esc' ? '\x1b' : key });
    return;
  }
  if (e.target.closest('#send')) {
    const inp = $('reply');
    sendText(inp.value);
    inp.value = '';
    return;
  }
  if (e.target.closest('[data-act="open"]')) {
    invoke('open_app', { target: P.sid });
    hide();
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

T.event.listen('pop-show', async ({ payload: sid }) => {
  P.sid = sid;
  lastH = 0;
  const st = await getState();
  P.agents = new Map(st.agents.map((a) => [a.sessionId, a]));
  P.tabs = st.tabs;
  await attachTerm(tabOf(agent()));
  render();
  setTimeout(() => $('reply')?.focus(), 50);
});

T.event.listen('agent', ({ payload: a }) => {
  if (a.status === 'ended') P.agents.delete(a.sessionId);
  else P.agents.set(a.sessionId, a);
  if (a.sessionId !== P.sid) return;
  // Yanıt yazılırken kartı baştan çizme; sadece durum değişince çiz.
  const typing = document.activeElement?.id === 'reply' && document.activeElement.value;
  if (!typing) render();
});
T.event.listen('tab', ({ payload: t }) => {
  const i = P.tabs.findIndex((x) => x.id === t.id);
  if (i >= 0) P.tabs[i] = t;
  else P.tabs.push(t);
});
T.event.listen('pty', ({ payload }) => {
  if (P.term && payload.id === P.termTab) {
    P.term.write(payload.data);
    refreshScreen();
  }
});
