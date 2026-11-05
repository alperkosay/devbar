// Bar ve ana pencerenin ortak yardımcıları.
const T = window.__TAURI__;
const invoke = T.core.invoke;
const $ = (id) => document.getElementById(id);
window.addEventListener('error', (e) => invoke('log', { msg: `${e.message} @ ${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => invoke('log', { msg: `promise: ${e.reason?.stack || e.reason}` }));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const folderName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'şimdi';
  if (s < 3600) return `${Math.floor(s / 60)} dk`;
  return `${Math.floor(s / 3600)} sa`;
};
const STATUS_LABEL = { running: 'Çalışıyor', waiting: 'Seni bekliyor', done: 'Bitti', idle: 'Hazır', off: 'Kapalı' };

// Öncelik: izin/cevap bekleyen > çalışan > biten > boşta. 3 saattir sessiz olanlar gizlenir.
const PRI = { waiting: 4, running: 3, done: 2, idle: 1 };
function sortedAgents(map) {
  const cut = Date.now() - 3 * 3600e3;
  return [...map.values()]
    .filter((a) => a.status !== 'ended' && (a.updated > cut || a.status === 'running' || a.status === 'waiting'))
    .sort((a, b) => (PRI[b.status] || 0) - (PRI[a.status] || 0) || b.updated - a.updated);
}

// Pencereler Rust tarafındaki kurulum bitmeden yüklenebiliyor; durum hazır olana kadar dene.
async function getState() {
  for (let i = 0; ; i++) {
    try {
      return await invoke('get_state');
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// Ayarlardaki hatırlatıcı ikonları.
const RICON = { water: I.water, stand: I.stand, eye: I.eye, bell: I.bell };
