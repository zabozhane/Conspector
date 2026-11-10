import { getSettings, listSessions, getSession, renderMarkdown, notesMarkdown, exportMarkdown, fmtTime } from './shared.js';
import { copyPrompt } from './prompts.js';

const $ = (id) => document.getElementById(id);
let rec = null, sessionId = null, session = null, tab = 'notes', notesBusy = false, settings = await getSettings();

function showErr(e) { $('err').hidden = !e; $('err').textContent = e || ''; }

async function loadSessions() {
  const index = await listSessions();
  const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
  sessionId = rec?.sessionId || (index.some((x) => x.id === sessionId) ? sessionId : currentSessionId || index[0]?.id || null);
  $('session').innerHTML = index.length
    ? index.map((x) => `<option value="${x.id}">${new Date(x.startedAt).toLocaleDateString('ru-RU')} · ${escapeHtml(x.title)}</option>`).join('')
    : '<option>Пока нет записей</option>';
  $('session').value = sessionId || '';
  await loadSession();
}

async function loadSession() {
  session = sessionId ? await getSession(sessionId) : null;
  render();
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render() {
  const recHere = rec && rec.sessionId === sessionId;
  $('statusText').innerHTML = rec
    ? `<span class="dot on"></span>Идёт запись${rec.queue ? ` · распознаётся ${rec.queue}` : ''}`
    : '<span class="dot"></span>Запись не идёт';
  $('toggle').className = rec ? 'rec' : 'primary';
  $('toggle').textContent = rec ? '■ Стоп' : '● Записать';

  const has = !!session?.segments.length;
  for (const id of ['copy', 'copyPrompt', 'download', 'update', 'summary']) $(id).disabled = !has;
  $('del').disabled = !session || recHere;
  const ai = settings.notesEngine !== 'plain';
  $('update').hidden = $('summary').hidden = !ai;
  $('update').disabled = !has || notesBusy;
  $('update').classList.toggle('spin', notesBusy);

  const errs = [session?.asrError, session?.notesError].filter(Boolean);
  if (errs.length) showErr(errs.join('\n'));

  if (!session) {
    $('notes').innerHTML = `<div class="empty">Откройте видео, нажмите <b>● Записать</b>,<br>и здесь начнёт собираться конспект.</div>`;
    $('transcript').innerHTML = '';
    return;
  }
  const md = notesMarkdown(session);
  let notesHtml = md ? renderMarkdown(md) : `<div class="empty">${recHere ? 'Слушаю видео… первый текст появится через 15–30 секунд.' : 'Текста нет.'}</div>`;
  if (ai && session.segments.length > session.notesUpto && session.notes) {
    notesHtml += `<p class="muted">Ещё ${session.segments.length - session.notesUpto} фрагм. ждут конспектирования${notesBusy ? '…' : ' — конспект дополнится автоматически'}.</p>`;
  } else if (ai && !session.notes && session.segments.length) {
    notesHtml = `<p class="muted">ИИ-конспект появится, когда наберётся несколько минут речи. Пока — расшифровка:</p>` + notesHtml;
  }
  $('notes').innerHTML = notesHtml;
  const atBottom = $('transcript').parentElement.scrollHeight - $('transcript').parentElement.scrollTop - $('transcript').parentElement.clientHeight < 60;
  $('transcript').innerHTML = session.segments.map((s) => `<div class="seg"><span class="t">${fmtTime(s.t)}</span>${escapeHtml(s.text)}</div>`).join('')
    || '<div class="empty">Пока пусто</div>';
  if (tab === 'transcript' && atBottom) $('transcript').parentElement.scrollTop = 1e9;
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('notes').hidden = t !== 'notes'; $('transcript').hidden = t !== 'transcript';
}
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => setTab(b.dataset.tab));

$('session').onchange = async (e) => { sessionId = e.target.value; showErr(''); await chrome.storage.local.set({ currentSessionId: sessionId }); loadSession(); };
$('opts').onclick = () => chrome.runtime.openOptionsPage();

$('toggle').onclick = async () => {
  showErr(''); $('toggle').disabled = true;
  let r;
  if (rec) r = await chrome.runtime.sendMessage({ type: 'stop' });
  else {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    r = await chrome.runtime.sendMessage({ type: 'start', tabId: t.id });
  }
  $('toggle').disabled = false;
  if (!r.ok) showErr(r.error);
  rec = (await chrome.runtime.sendMessage({ type: 'get-status' })).rec;
  await loadSessions();
};

async function action(btn, type) {
  showErr(''); btn.disabled = true;
  const r = await chrome.runtime.sendMessage({ type, sessionId });
  btn.disabled = false;
  if (!r.ok) showErr(r.error);
}
$('update').onclick = () => action($('update'), 'make-notes');
$('summary').onclick = () => { $('summary').textContent = 'Итоги…'; action($('summary'), 'make-summary').then(() => $('summary').textContent = 'Итоги'); };

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent; btn.textContent = 'Скопировано ✓'; setTimeout(() => btn.textContent = old, 1500);
}
$('copy').onclick = () => copy(tab === 'notes' ? notesMarkdown(session) : session.segments.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join('\n'), $('copy'));
$('copyPrompt').onclick = () => copy(copyPrompt(session.segments.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join('\n')), $('copyPrompt'));
$('download').onclick = () => {
  const blob = new Blob([exportMarkdown(session)], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (session.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'konspekt') + '.md';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('del').onclick = async () => {
  if (!confirm('Удалить эту запись и конспект?')) return;
  await chrome.runtime.sendMessage({ type: 'delete-session', sessionId });
  sessionId = null; showErr(''); loadSessions();
};

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== 'local') return;
  if (ch.settings) settings = await getSettings();
  if (ch.sessionIndex) return loadSessions();
  if (sessionId && ch['session:' + sessionId]) { session = ch['session:' + sessionId].newValue; render(); }
  else if (ch.settings) render();
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'status') { rec = m.rec; if (m.error) showErr(m.error); loadSessions(); }
  if (m.type === 'status-queue' && rec) { rec.queue = m.queue; render(); }
  if (m.type === 'notes-progress' && m.sessionId === sessionId) { notesBusy = m.busy; render(); }
  if (m.type === 'local-progress') {
    const p = $('progress');
    if (m.status === 'downloading') { p.hidden = false; p.textContent = `Скачиваю модель распознавания: ${Math.round(m.loaded / m.total * 100)}% (${Math.round(m.total / 1e6)} МБ, только в первый раз)`; }
    else if (m.status === 'ready') { p.hidden = false; p.textContent = `Локальная модель готова (${m.device === 'webgpu' ? 'видеокарта' : 'процессор'})`; setTimeout(() => p.hidden = true, 4000); }
    else if (m.status === 'error') { p.hidden = true; showErr('Локальная модель не загрузилась: ' + m.error); }
  }
});

rec = (await chrome.runtime.sendMessage({ type: 'get-status' })).rec;
await loadSessions();
