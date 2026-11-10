import { getSettings, getSession, listSessions, fmtTime, PROVIDERS } from './shared.js';
import { NOTES_SYSTEM, notesUserPrompt, SUMMARY_SYSTEM } from './prompts.js';

// ---------- состояние записи (переживает перезапуск service worker) ----------
async function getRec() { return (await chrome.storage.session.get('rec')).rec || null; }
async function setRec(rec) { await chrome.storage.session.set({ rec }); broadcastStatus(); }

async function broadcastStatus(extra = {}) {
  const rec = await getRec();
  chrome.runtime.sendMessage({ type: 'status', rec, ...extra }).catch(() => {});
  await chrome.action.setBadgeText({ text: rec ? 'REC' : '' });
  if (rec) await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// ---------- offscreen-документ ----------
async function ensureOffscreen() {
  const has = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (has.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WORKERS'],
      justification: 'Захват звука вкладки и распознавание речи'
    });
  } catch (e) {
    if (!String(e.message).includes('single offscreen')) throw e;
  }
}

// ---------- сессии: последовательная запись в storage ----------
let writeChain = Promise.resolve();
function updateSession(id, fn) {
  writeChain = writeChain.then(async () => {
    const s = await getSession(id);
    if (!s) return null;
    await fn(s);
    await chrome.storage.local.set({ ['session:' + id]: s });
    return s;
  }).catch((e) => { console.error(e); return null; });
  return writeChain;
}

async function createSession(tab) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const s = {
    id, title: tab.title || 'Без названия', url: tab.url || '', startedAt: Date.now(),
    segments: [], notes: '', notesUpto: 0, summary: ''
  };
  const index = await listSessions();
  index.unshift({ id, title: s.title, url: s.url, startedAt: s.startedAt });
  await chrome.storage.local.set({ ['session:' + id]: s, sessionIndex: index, currentSessionId: id });
  return s;
}

export async function deleteSession(id) {
  const index = (await listSessions()).filter((x) => x.id !== id);
  await chrome.storage.local.remove('session:' + id);
  await chrome.storage.local.set({ sessionIndex: index, currentSessionId: index[0]?.id || null });
}

// ---------- старт / стоп ----------
async function startRecording(tabId) {
  const current = await getRec();
  if (current) await stopRecording();
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || '')) throw new Error('Откройте вкладку с видео (обычный сайт), а не служебную страницу.');
  const settings = await getSettings();
  if (settings.asrEngine !== 'local' && !settings.keys[settings.asrEngine]) {
    throw new Error('Нет API-ключа. Откройте настройки и вставьте ключ Groq (он бесплатный) или выберите локальный режим.');
  }
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    throw new Error('Chrome не дал доступ к звуку вкладки. Нажмите на значок Конспектора на вкладке с видео (или Alt+Shift+S) и попробуйте ещё раз.\n' + e.message);
  }
  await ensureOffscreen();
  const session = await createSession(tab);
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-start', streamId, sessionId: session.id, settings });
  if (!res?.ok) throw new Error(res?.error || 'Не удалось начать захват звука');
  await setRec({ tabId, sessionId: session.id, startedAt: Date.now(), queue: 0 });
  return session.id;
}

async function stopRecording() {
  const rec = await getRec();
  if (!rec) return;
  await chrome.runtime.sendMessage({ type: 'offscreen-stop' }).catch(() => {});
  await setRec(null);
  // дописать конспект по остатку текста
  maybeMakeNotes(rec.sessionId, true);
}

// ---------- конспект ----------
const notesBusy = new Set();

async function callLLM(engine, settings, system, user) {
  if (engine === 'chrome') {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ type: 'offscreen-llm', system, user });
    if (!r?.ok) throw new Error(r?.error || 'Встроенный ИИ Chrome недоступен');
    return r.text;
  }
  const key = settings.keys[engine];
  if (!key) throw new Error(`Нет API-ключа для ${PROVIDERS[engine].name}`);
  let model = settings.models[engine].llm;
  let switched = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = {
      model,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    };
    // у reasoning-моделей gpt-oss размышления не нужны — экономим лимит и время
    if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
    const r = await fetch(PROVIDERS[engine].baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.status === 429) {
      const wait = Math.min(60, parseFloat(r.headers.get('retry-after')) || 10 * (attempt + 1));
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      continue;
    }
    if (!r.ok) {
      const text = await r.text();
      // модель сняли с провайдера — сами выбираем доступную и запоминаем её
      if (!switched && (r.status === 404 || /model_not_found|decommissioned|does not exist/i.test(text))) {
        const next = await pickChatModel(engine, key, model);
        if (next) {
          model = next; switched = true;
          const st = await getSettings();
          st.models[engine].llm = next;
          await chrome.storage.local.set({ settings: st });
          continue;
        }
      }
      throw new Error(`Ошибка ИИ (${r.status}): ${text.slice(0, 300)}`);
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  throw new Error('Превышен лимит запросов к ИИ, попробуйте позже');
}

// Выбор доступной чат-модели из списка провайдера
const PREFERRED = ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct',
  'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'gpt-4o-mini', 'gpt-4.1-mini'];
async function pickChatModel(engine, key, broken) {
  try {
    const r = await fetch(PROVIDERS[engine].baseUrl + '/models', { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) return null;
    const ids = (await r.json()).data.filter((m) => m.active !== false).map((m) => m.id)
      .filter((id) => id !== broken && !/whisper|tts|guard|embed|transcribe|audio|image|dall|moderation|prompt-guard|orpheus|playai/i.test(id));
    return PREFERRED.find((id) => ids.includes(id)) || ids.find((id) => /gpt-oss|llama|qwen|kimi|gpt-4/i.test(id)) || ids[0] || null;
  } catch { return null; }
}

async function maybeMakeNotes(sessionId, force = false) {
  const settings = await getSettings();
  if (settings.notesEngine === 'plain' || notesBusy.has(sessionId)) return;
  notesBusy.add(sessionId);
  try {
    // обрабатываем порциями, пока есть необработанный текст
    for (;;) {
      const s = await getSession(sessionId);
      if (!s) return;
      const pending = s.segments.slice(s.notesUpto);
      const chars = pending.reduce((n, x) => n + x.text.length, 0);
      if (!pending.length || (!force && chars < settings.notesEveryChars)) return;
      if (force && chars < 80) return;
      // берём не больше ~6000 символов за раз (лимиты бесплатного тарифа)
      let take = 0, acc = 0;
      while (take < pending.length && (acc < 6000 || take === 0)) { acc += pending[take].text.length; take++; }
      const part = pending.slice(0, take);
      const range = `${fmtTime(part[0].t)}–${fmtTime(part[part.length - 1].t + 30)}`;
      const fragment = part.map((x) => `[${fmtTime(x.t)}] ${x.text}`).join('\n');
      chrome.runtime.sendMessage({ type: 'notes-progress', sessionId, busy: true }).catch(() => {});
      let text = await callLLM(settings.notesEngine, settings, NOTES_SYSTEM, notesUserPrompt(s.notes.slice(-1200), fragment, range));
      text = text.trim();
      if (/^ПУСТО\.?$/i.test(text)) text = '';
      await updateSession(sessionId, (ss) => {
        if (text) ss.notes = (ss.notes ? ss.notes.trimEnd() + '\n\n' : '') + text;
        ss.notesUpto = s.notesUpto + take;
        ss.notesError = '';
      });
    }
  } catch (e) {
    await updateSession(sessionId, (ss) => { ss.notesError = e.message; });
  } finally {
    notesBusy.delete(sessionId);
    chrome.runtime.sendMessage({ type: 'notes-progress', sessionId, busy: false }).catch(() => {});
  }
}

async function makeSummary(sessionId) {
  const settings = await getSettings();
  if (settings.notesEngine === 'plain') throw new Error('Итоги делает ИИ — выберите его в настройках');
  await maybeMakeNotes(sessionId, true);
  const s = await getSession(sessionId);
  const source = s.notes?.trim() || s.segments.map((x) => x.text).join(' ').slice(0, 12000);
  if (!source) throw new Error('Пока нечего подытоживать');
  const text = await callLLM(settings.notesEngine, settings, SUMMARY_SYSTEM, source.slice(-14000));
  await updateSession(sessionId, (ss) => { ss.summary = text.trim(); });
}

// ---------- сообщения ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => p.then((v) => sendResponse({ ok: true, ...(v || {}) }), (e) => sendResponse({ ok: false, error: e.message }));
  switch (msg.type) {
    case 'start': reply(startRecording(msg.tabId).then((sessionId) => ({ sessionId }))); return true;
    case 'stop': reply(stopRecording()); return true;
    case 'get-status': reply(getRec().then((rec) => ({ rec }))); return true;
    case 'make-notes': reply(maybeMakeNotes(msg.sessionId, true)); return true;
    case 'make-summary': reply(makeSummary(msg.sessionId)); return true;
    case 'delete-session': reply(deleteSession(msg.sessionId)); return true;
    case 'preload-local': reply(ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: 'offscreen-preload', model: msg.model }))); return true;

    // от offscreen-документа
    case 'segment':
      updateSession(msg.sessionId, (s) => { s.segments.push({ t: msg.t, text: msg.text }); })
        // фрагменты, распознанные уже после «Стоп», конспектируем сразу, без ожидания порога
        .then(() => getRec()).then((rec) => maybeMakeNotes(msg.sessionId, rec?.sessionId !== msg.sessionId));
      return false;
    case 'queue':
      getRec().then((rec) => { if (rec) { rec.queue = msg.queue; chrome.storage.session.set({ rec }); } });
      chrome.runtime.sendMessage({ type: 'status-queue', queue: msg.queue }).catch(() => {});
      return false;
    case 'capture-ended':
      stopRecording();
      return false;
    case 'asr-error':
      getRec().then((rec) => rec && updateSession(rec.sessionId, (s) => { s.asrError = msg.error; }));
      return false;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  const rec = await getRec();
  try {
    if (rec) await stopRecording();
    else if (tab?.id) await startRecording(tab.id);
  } catch (e) {
    broadcastStatus({ error: e.message });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec?.tabId === tabId) stopRecording();
});
