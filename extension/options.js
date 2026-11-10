import { getSettings, saveSettings, LOCAL_MODELS, PROVIDERS, DEFAULT_SETTINGS } from './shared.js';
const $ = (id) => document.getElementById(id);
const s = await getSettings();

$('localModel').innerHTML = Object.entries(LOCAL_MODELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('asrEngine').value = s.asrEngine; $('notesEngine').value = s.notesEngine;
$('localModel').value = s.localModel; $('language').value = s.language;
$('muteTab').checked = s.muteTab; $('notesEveryChars').value = s.notesEveryChars;
$('key-groq').value = s.keys.groq; $('key-openai').value = s.keys.openai;
for (const p of ['groq', 'openai']) { $(`m-${p}-asr`).value = s.models[p].asr; $(`m-${p}-llm`).value = s.models[p].llm; }

const sync = () => { $('localBox').hidden = $('asrEngine').value !== 'local'; $('chromeBox').hidden = $('notesEngine').value !== 'chrome'; };
$('asrEngine').onchange = $('notesEngine').onchange = sync; sync();

function collect() {
  const n = structuredClone(s);
  n.asrEngine = $('asrEngine').value; n.notesEngine = $('notesEngine').value;
  n.localModel = $('localModel').value; n.language = $('language').value; n.muteTab = $('muteTab').checked;
  n.notesEveryChars = Math.max(800, parseInt($('notesEveryChars').value) || DEFAULT_SETTINGS.notesEveryChars);
  n.keys = { groq: $('key-groq').value.trim(), openai: $('key-openai').value.trim() };
  for (const p of ['groq', 'openai']) n.models[p] = { asr: $(`m-${p}-asr`).value.trim() || PROVIDERS[p].asrModel, llm: $(`m-${p}-llm`).value.trim() || PROVIDERS[p].llmModel };
  return n;
}

$('save').onclick = async () => {
  const n = collect();
  if (n.asrEngine !== 'local' && !n.keys[n.asrEngine]) { alert('Для выбранного распознавания нужен ключ — или выберите «Локально в браузере».'); return; }
  await saveSettings(n);
  $('saved').hidden = false; setTimeout(() => $('saved').hidden = true, 2000);
};

document.querySelectorAll('[data-test]').forEach((b) => b.onclick = async () => {
  const p = b.dataset.test, key = $('key-' + p).value.trim();
  if (!key) return alert('Сначала вставьте ключ');
  b.textContent = '…';
  try {
    const r = await fetch(PROVIDERS[p].baseUrl + '/models', { headers: { Authorization: 'Bearer ' + key } });
    b.textContent = r.ok ? 'Ключ работает ✓' : `Ошибка ${r.status}`;
  } catch (e) { b.textContent = 'Нет связи'; }
});

$('preload').onclick = async () => {
  await saveSettings(collect());
  $('preloadStatus').textContent = 'Загрузка…';
  const r = await chrome.runtime.sendMessage({ type: 'preload-local', model: $('localModel').value });
  if (r && r.ok === false) $('preloadStatus').textContent = 'Ошибка: ' + r.error;
};
chrome.runtime.onMessage.addListener((m) => {
  if (m.type !== 'local-progress') return;
  if (m.status === 'downloading') $('preloadStatus').textContent = `Скачано ${Math.round(m.loaded / m.total * 100)}% из ${Math.round(m.total / 1e6)} МБ`;
  if (m.status === 'ready') $('preloadStatus').textContent = `Готово ✓ (${m.device === 'webgpu' ? 'видеокарта' : 'процессор'})`;
  if (m.status === 'error') $('preloadStatus').textContent = 'Ошибка: ' + m.error;
});

$('chromeAi').onclick = async () => {
  const st = $('chromeStatus');
  if (!('LanguageModel' in self)) { st.textContent = 'Не поддерживается этой версией Chrome / устройством'; return; }
  try {
    let a = await LanguageModel.availability();
    if (a === 'unavailable') { st.textContent = 'Недоступно на этом устройстве'; return; }
    if (a === 'available') { st.textContent = 'Готово ✓'; return; }
    st.textContent = 'Скачиваю модель…';
    const m = await LanguageModel.create({ monitor(mon) { mon.addEventListener('downloadprogress', (e) => st.textContent = `Скачано ${Math.round(e.loaded * 100)}%`); } });
    m.destroy(); st.textContent = 'Готово ✓';
  } catch (e) { st.textContent = 'Ошибка: ' + e.message; }
};
