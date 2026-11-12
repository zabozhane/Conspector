// Внедряется во все фреймы вкладки на время записи. Находит видеоплеер (<video>)
// на любом сайте (в т.ч. во встроенных iframe), сообщает о паузе/окончании
// и умеет менять скорость воспроизведения.
(() => {
  if (window.__conspectorProbe) return;
  window.__conspectorProbe = true;

  const area = (v) => { const r = v.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
  function mainVideo() {
    let best = null, bestScore = -1;
    for (const v of document.querySelectorAll('video')) {
      if (!v.duration && v.readyState === 0) continue;
      // играющее видео важнее, затем самое большое на экране
      const score = (v.paused ? 0 : 1e9) + area(v);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  let last = 0;
  function report(ev) {
    const v = mainVideo();
    if (!v) return;
    const now = Date.now();
    if (ev === 'timeupdate' && now - last < 2000) return;
    last = now;
    chrome.runtime.sendMessage({
      type: 'video-state', ev, wall: now,
      currentTime: v.currentTime, paused: v.paused || v.ended, ended: v.ended,
      rate: v.playbackRate || 1, area: area(v), duration: v.duration || 0
    }).catch(() => {});
  }

  for (const ev of ['play', 'playing', 'pause', 'seeked', 'ratechange', 'ended', 'timeupdate']) {
    document.addEventListener(ev, (e) => { if (e.target instanceof HTMLVideoElement) report(ev); }, true);
  }
  report('init');

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'cs-rate') {
      const v = mainVideo();
      if (!v) return false;
      v.playbackRate = msg.rate;
      sendResponse({ ok: true });
    }
    if (msg.type === 'cs-probe') { report('probe'); }
    return false;
  });
})();
