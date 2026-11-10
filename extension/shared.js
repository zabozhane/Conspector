// Общие настройки и хелперы (ES-модуль)
export const PROVIDERS = {
  groq: {
    name: 'Groq (бесплатный ключ)',
    baseUrl: 'https://api.groq.com/openai/v1',
    asrModel: 'whisper-large-v3-turbo',
    llmModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys'
  },
  openai: {
    name: 'OpenAI (платно)',
    baseUrl: 'https://api.openai.com/v1',
    asrModel: 'gpt-4o-mini-transcribe',
    llmModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys'
  }
};

export const LOCAL_MODELS = {
  'onnx-community/whisper-tiny': 'Tiny — ~75 МБ, быстро, качество слабое',
  'onnx-community/whisper-base': 'Base — ~150 МБ, быстро, качество среднее',
  'onnx-community/whisper-small': 'Small — ~250 МБ, хороший русский (рекомендуется)',
  'onnx-community/whisper-large-v3-turbo': 'Large v3 Turbo — ~800 МБ, лучший русский, нужен M1+ и WebGPU'
};

export const DEFAULT_SETTINGS = {
  asrEngine: 'groq',          // 'groq' | 'openai' | 'local'
  notesEngine: 'groq',        // 'groq' | 'openai' | 'plain'
  keys: { groq: '', openai: '' },
  models: {
    groq: { asr: PROVIDERS.groq.asrModel, llm: PROVIDERS.groq.llmModel },
    openai: { asr: PROVIDERS.openai.asrModel, llm: PROVIDERS.openai.llmModel }
  },
  localModel: 'onnx-community/whisper-small',
  language: 'ru',
  notesEveryChars: 3500,      // примерно каждые 3–4 минуты речи
  muteTab: false              // true — звук видео не слышен во время записи
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = structuredClone(DEFAULT_SETTINGS);
  if (settings) {
    Object.assign(s, settings);
    s.keys = { ...DEFAULT_SETTINGS.keys, ...(settings.keys || {}) };
    s.models = {
      groq: { ...DEFAULT_SETTINGS.models.groq, ...(settings.models?.groq || {}) },
      openai: { ...DEFAULT_SETTINGS.models.openai, ...(settings.models?.openai || {}) }
    };
  }
  return s;
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// --- Сессии (одна сессия = одна запись видео) ---
export async function listSessions() {
  const { sessionIndex = [] } = await chrome.storage.local.get('sessionIndex');
  return sessionIndex;
}
export async function getSession(id) {
  const key = 'session:' + id;
  const r = await chrome.storage.local.get(key);
  return r[key] || null;
}

// Конспект без ИИ: расшифровка, сгруппированная в абзацы по ~2 минуты
export function plainNotes(session) {
  const out = [];
  let para = [], paraStart = null;
  for (const seg of session.segments) {
    if (paraStart === null) paraStart = seg.t;
    para.push(seg.text);
    if (seg.t - paraStart >= 120) {
      out.push(`**[${fmtTime(paraStart)}]** ${para.join(' ')}`);
      para = []; paraStart = null;
    }
  }
  if (para.length) out.push(`**[${fmtTime(paraStart)}]** ${para.join(' ')}`);
  return out.join('\n\n');
}

export function notesMarkdown(session) {
  const parts = [];
  if (session.summary) parts.push('## Кратко\n\n' + session.summary.trim());
  if (session.notes && session.notes.trim()) parts.push('## Конспект\n\n' + session.notes.trim());
  else if (session.segments.length) parts.push('## Конспект\n\n' + plainNotes(session));
  return parts.join('\n\n');
}

export function exportMarkdown(session) {
  const date = new Date(session.startedAt).toLocaleString('ru-RU');
  const transcript = session.segments.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join('\n');
  return `# ${session.title}\n\nИсточник: ${session.url}\nДата: ${date}\n\n${notesMarkdown(session)}\n\n## Полная расшифровка\n\n${transcript}\n`;
}

// Мини-рендер Markdown → HTML (заголовки, списки, жирный, курсив, код)
export function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const lines = md.split('\n');
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList(); const lvl = Math.min(m[1].length + 1, 5);
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList(); html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}
