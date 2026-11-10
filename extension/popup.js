const $ = (id) => document.getElementById(id);
let rec = null;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

function render() {
  const here = rec && rec.tabId === tab.id;
  $('status').innerHTML = rec
    ? `<span class="dot on"></span>Идёт запись${here ? ' этой вкладки' : ' другой вкладки'}${rec.queue ? ` · в очереди ${rec.queue}` : ''}`
    : '<span class="dot"></span>Запись не идёт';
  $('toggle').className = rec ? 'rec' : 'primary';
  $('toggle').textContent = rec ? '■ Остановить запись' : '● Начать запись этой вкладки';
}
function showErr(e) { $('err').hidden = !e; $('err').textContent = e || ''; }

rec = (await chrome.runtime.sendMessage({ type: 'get-status' })).rec;
render();

$('toggle').onclick = async () => {
  showErr(''); $('toggle').disabled = true;
  const r = await chrome.runtime.sendMessage(rec ? { type: 'stop' } : { type: 'start', tabId: tab.id });
  $('toggle').disabled = false;
  if (!r.ok) return showErr(r.error);
  rec = (await chrome.runtime.sendMessage({ type: 'get-status' })).rec;
  render();
  if (rec) chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close()).catch(() => {});
};
$('panel').onclick = () => chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close());
$('opts').onclick = () => chrome.runtime.openOptionsPage();
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'status') { rec = m.rec; render(); if (m.error) showErr(m.error); } });
