// ==UserScript==
// @name         雨课堂连续播放助手
// @namespace    local.yuketang.playback
// @version      1.3.0
// @description  二倍速静音，跳过已完成和非视频章节；发现完成立即切换。
// @match        https://www.yuketang.cn/ai-workspace/lms-graph/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self || document.getElementById('yt-helper')) return;
  const $ = (s, root = document) => root.querySelector(s);
  const all = (s, root = document) => [...root.querySelectorAll(s)];
  const text = e => (e?.textContent || '').trim();
  const courseId = () => location.pathname.match(/\/lms-graph\/(\d+)/)?.[1] || '';
  const route = () => location.pathname + location.search;
  const title = row => text($('.leaf-item-title', row));
  const isVideo = row => text($('.leaf-item-tag', row)) === '视频';
  // Observed on the actual course directory, 2026-10-22.
  const complete = row => !!$('.leaf-item-status .icon-yuanquangou-mianzhuang', row);
  const source = v => v?.currentSrc || v?.getAttribute('src') || '';
  let course = courseId(), running = false, pending = null, bound = null;
  let skipped = 0, generation = 0, state = '待启动', missingSince = 0;
  let lastTime = -1, lastMovement = Date.now(), abort = null, scheduled = false;
  const key = () => `yt-helper-v1:${course}`;
  const save = () => { try { sessionStorage.setItem(key(), running ? '1' : '0'); } catch {} };
  const panel = document.createElement('aside');
  panel.id = 'yt-helper';
  panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:280px;padding:16px;background:#152238;color:#fff;border-radius:12px;font:14px/1.6 sans-serif;box-shadow:0 4px 24px #0005';
  panel.innerHTML = '<strong>雨课堂连续播放 · 2倍速 / 静音</strong><div data-name></div><div data-status></div><div data-count></div><button data-start>开始</button> <button data-stop>暂停</button>';
  document.body.append(panel);
  function render() {
    const row = $('.leaf-item.is-active');
    for (const [sel, value] of [['[data-name]', row ? title(row) : '等待课程目录'], ['[data-status]', state], ['[data-count]', `已跳过 ${skipped} 项`]]) {
      const e = $(sel, panel); if (e.textContent !== value) e.textContent = value;
    }
  }
  function detach() { abort?.abort(); abort = null; bound = null; }
  function stop(reason) {
    running = false; generation++; pending = null; detach(); save();
    $('video.xt_video_player')?.pause(); state = reason; render();
  }
  function visible(e) { return !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'; }
  function blocked() {
    return all('[role="dialog"], .el-dialog__wrapper, .el-message-box__wrapper').some(e => visible(e) && /答题|验证码|验证|登录|测验|考试/.test(text(e)));
  }
  function advance() {
    if (!running || pending) return;
    const rows = all('.leaf-item'), current = $('.leaf-item.is-active');
    const index = rows.indexOf(current);
    if (index < 0) return stop('无法识别当前章节，请重新打开视频页');
    // Lock synchronously before pause / ended events or DOM callbacks can fire.
    const old = $('video.xt_video_player');
    pending = { old, src: source(old), route: route(), at: Date.now(), target: null, index: -1, name: '' };
    detach(); old?.pause();
    let next = index + 1;
    while (next < rows.length && (!isVideo(rows[next]) || complete(rows[next]))) { skipped++; next++; }
    if (next === rows.length) return stop('后续视频已播放完毕');
    Object.assign(pending, { target: rows[next], index: next, name: title(rows[next]) });
    state = '正在切换下一段视频'; render();
    rows[next].click();
  }
  function bind(v, row, trustProgress) {
    detach();
    const token = ++generation;
    abort = new AbortController();
    bound = { v, row, route: route(), src: source(v), progressTrusted: trustProgress };
    const on = (name, cb) => v.addEventListener(name, cb, { signal: abort.signal });
    let applying = false, attempts = 0;
    function mouse(element, type, x, y) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter', cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 }));
    }
    function activate(element) {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      // The site's speed handler records mouseover coordinates and requires
      // a nonzero mousemove distance before accepting click. Do not send a
      // second mouseover after mousemove: that resets its origin.
      mouse(element, 'mouseover', x - 2, y - 2);
      mouse(element, 'mouseenter', x - 2, y - 2);
      mouse(element, 'mousemove', x, y);
      mouse(element, 'mousedown', x, y);
      mouse(element, 'mouseup', x, y);
      mouse(element, 'click', x, y);
    }
    const apply = () => {
      if (!running || token !== generation || applying || v.paused) return;
      const wrap = v.closest('.xt_video_player_wrap');
      const speed = wrap && $('.xt_video_player_speed li[data-speed="2"]', wrap);
      const volume = wrap && $('.xt_video_player_volume .xt_video_player_common_icon', wrap);
      if (!speed || !volume) return stop('未找到网站原生倍速或静音控件');
      const label = () => text($('.xt_video_player_speed .xt_video_player_common_value', wrap));
      const rateOK = () => v.playbackRate === 2 && /^2(?:\.0+)?X$/i.test(label());
      const muteOK = () => v.muted || v.volume === 0;
      if (rateOK() && muteOK()) { attempts = 0; return; }
      applying = true; attempts++;
      if (!rateOK()) {
        const menu = $('.xt_video_player_speed', wrap);
        if (menu) { const r = menu.getBoundingClientRect(); mouse(menu, 'mouseenter', r.left, r.top); }
        activate(speed);
      }
      if (!muteOK()) activate(volume);
      setTimeout(() => {
        applying = false;
        if (!running || token !== generation) return;
        if (rateOK() && muteOK()) { attempts = 0; state = '播放中 · 原生2倍速 / 静音'; render(); return; }
        if (attempts < 3) { apply(); return; }
        const failed = [!rateOK() ? `倍速仍为 ${label()}（实际 ${v.playbackRate} 倍）` : '', !muteOK() ? '静音未生效' : ''].filter(Boolean).join('；');
        stop(`${failed}。原生控件重试3次未成功，请手动设置后点击开始`);
      }, 1500);
    };
    on('ended', advance);
    on('error', () => stop('视频加载失败，请检查网络后重新开始'));
    on('pause', () => {
      // ended may arrive immediately after pause; give the ended handler a turn.
      setTimeout(() => { if (running && token === generation && !pending && v.paused && !v.ended) stop('播放已暂停；处理页面提示后点击开始'); }, 150);
    });
    on('ratechange', apply); on('volumechange', apply); on('playing', apply);
    if (!running || token !== generation) return;
    lastTime = v.currentTime; lastMovement = Date.now();
    state = '播放中'; render();
    Promise.resolve(v.play()).then(apply).catch(() => { if (token === generation && running) stop('浏览器阻止播放或媒体未就绪，请手动播放后点击开始'); });
  }
  function tick() {
    scheduled = false;
    if (courseId() !== course) {
      stop('已切换课程，请点击开始'); course = courseId(); save(); skipped = 0;
    }
    if (!running) return;
    if (blocked()) return stop('页面需要答题、验证或登录，请手动处理');
    const row = $('.leaf-item.is-active'), v = $('video.xt_video_player');
    if (pending) {
      const p = pending;
      if (Date.now() - p.at > 30000) return stop('下一节加载超时，请检查页面后重新开始');
      const rows = all('.leaf-item');
      const isTarget = row && (row === p.target || (rows.indexOf(row) === p.index && title(row) === p.name));
      const freshMedia = v && (v !== p.old || source(v) !== p.src);
      if (!isTarget || route() === p.route || !freshMedia || v.readyState < 1) return;
      // A changed player and route are required. A stale 100% is not trusted
      // until the progress DOM changes or first reports a non-complete value.
      const progress = $('.rate-detail');
      const trust = !/完成度[：:]\s*100(?:\.0+)?\s*%/.test(text(progress));
      pending = null; bind(v, row, trust);
    }
    if (!row) {
      missingSince ||= Date.now();
      if (Date.now() - missingSince > 30000) stop('课程目录加载超时');
      return;
    }
    if (!isVideo(row)) { skipped++; return advance(); }
    if (complete(row)) { skipped++; return advance(); }
    if (!v || v.readyState < 1) {
      missingSince ||= Date.now();
      if (Date.now() - missingSince > 30000) stop('播放器加载超时');
      return;
    }
    missingSince = 0;
    if (bound && (bound.row !== row || bound.route !== route())) return stop('检测到手动切换，请点击开始');
    if (bound && (bound.v !== v || bound.src !== source(v))) bind(v, row, false);
    if (!bound) bind(v, row, true);
    if (!running || !bound) return;
    const headerMatches = text($('.unit-title')) === title(row);
    const progressText = text($('.rate-detail'));
    const done = /完成度[：:]\s*100(?:\.0+)?\s*%/.test(progressText);
    if (!done) bound.progressTrusted = true;
    if (headerMatches && done && bound.progressTrusted) { skipped++; return advance(); }
    if (v.ended) return advance();
    if (v.currentTime !== lastTime) { lastTime = v.currentTime; lastMovement = Date.now(); }
    if (Date.now() - lastMovement > 60000) return stop('播放超过60秒未前进，请检查网络或页面提示');
    render();
  }
  function schedule() { if (!scheduled) { scheduled = true; queueMicrotask(tick); } }
  new MutationObserver(records => {
    const relevant = records.filter(r => !panel.contains(r.target));
    if (!relevant.length) return;
    const progress = $('.rate-detail');
    const changed = relevant.some(r => progress && (r.target === progress || progress.contains(r.target)));
    if (changed && bound && !pending) bound.progressTrusted = true;
    schedule();
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'src', 'style'] });
  function start() {
    if (running) return;
    detach(); pending = null; running = true; missingSince = 0; save(); state = '正在检查课程'; tick();
  }
  $('[data-start]', panel).addEventListener('click', start);
  $('[data-stop]', panel).addEventListener('click', () => stop('已暂停'));
  setInterval(tick, 1000); render();
  try { if (sessionStorage.getItem(key()) === '1') start(); } catch {}
})();
