// Lucide tarzı satır ikonları.
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const I = {
  spark: svg('<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke-width="2.4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  sliders: svg('<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>'),
  up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  terminal: svg('<path d="m4 17 6-6-6-6M12 19h8"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  alert: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/>'),
  pen: svg('<path d="M12 20h9M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.8.8-2.9a2 2 0 0 1 .5-.9z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  globe: svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>'),
  bot: svg('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>'),
  wrench: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>'),
  list: svg('<path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/>'),
  power: svg('<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
};
