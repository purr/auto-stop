// Auto-Stop Media - Media Controller (content script)
//
// One file, two detection modes:
//
//  • Universal mode (almost every site): media events (play/pause/volumechange/ended)
//    don't bubble but DO fire in the capture phase, so a single set of document listeners
//    catches every <audio>/<video>, including ones created after load. The element that
//    owns the audio is the one that is playing && !muted && volume > 0 (audible). Muted
//    media is ignored. Visibility is only a tiebreak when two elements are audible at once.
//
//  • Site mode (a few sites whose player can't be observed as a DOM media element — e.g.
//    SoundCloud streams through a detached/MSE <audio> that capture listeners never see):
//    a small SITE_CONTROLLERS entry drives detection by polling the site's own player
//    (its play button, timeline) and control by clicking the site's buttons.
//
// Everything else — the message protocol, fade engine, background contract — is shared.

const MC_CONFIG = {
  RECOMPUTE_DEBOUNCE: 60,      // Universal: settle window before picking the winner (ms)
  SITE_POLL_INTERVAL: 400,     // Site mode: how often to poll the site's player (ms)
  TIME_UPDATE_THROTTLE: 500,   // Minimum gap between progress updates (ms)
  PRUNE_INTERVAL: 4000,        // Universal: drop elements removed from the DOM (ms)
  FADE_STEP_MS: 40,            // Fade tick cadence (browsers throttle to ~1s in background tabs)
  VOL_EVENT_GUARD_MS: 250,     // Ignore volumechange events we caused within this window
  MIN_READY_STATE: 2           // HAVE_CURRENT_DATA — element actually has media to play
};

// ---------------------------------------------------------------------------
// Site controllers. `detect: true` means the site is handled entirely in site mode
// (universal element detection is skipped for it). Without `detect`, only the override
// hooks (next/prev/getTitle/...) are used to enhance universal mode. Selected by hostname.
// ---------------------------------------------------------------------------
const SITE_CONTROLLERS = [
  {
    match: 'soundcloud.com',
    detect: true,
    playButton: () =>
      document.querySelector('.playControl') ||
      document.querySelector('.playControls__play') ||
      document.querySelector('button.playControl'),
    isPlaying() {
      const btn = this.playButton();
      if (!btn) return false;
      if (btn.classList.contains('playing')) return true;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('pause') && !aria.includes('play')) return true;
      const title = (btn.getAttribute('title') || '').toLowerCase();
      if (title.includes('pause') && !title.includes('play')) return true;
      if (document.querySelector('.playControls')?.classList.contains('m-playing')) return true;
      return false;
    },
    play() { if (!this.isPlaying()) this.playButton()?.click(); },
    pause() { if (this.isPlaying()) this.playButton()?.click(); },
    next: () => clickFirst(['.playControls__next', '.skipControl__next']),
    prev: () => clickFirst(['.playControls__prev', '.skipControl__previous']),
    setVolume(v) {
      const slider = document.querySelector(
        '.volume__sliderWrapper input[type="range"], .playControls__volume input[type="range"], input.volume__slider, [class*="volume"] input[type="range"]'
      );
      if (slider) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(slider, v * 100);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelectorAll('audio').forEach(a => { a.volume = v; });
    },
    getVolume() {
      const a = document.querySelector('audio');
      return a ? a.volume : 1;
    },
    getTitle() {
      for (const sel of [
        '.playbackSoundBadge__titleLink',
        '.playbackSoundBadge__title span[aria-hidden="true"]',
        '.soundTitle__title span'
      ]) {
        const el = document.querySelector(sel);
        const t = el?.textContent?.trim().replace(/^Current track:\s*/i, '');
        if (t) return t.substring(0, 120);
      }
      return '';
    },
    getCover() {
      for (const sel of [
        '.playbackSoundBadge__avatar span[style*="background"]',
        '.sc-artwork span[style*="background-image"]'
      ]) {
        const el = document.querySelector(sel);
        const style = el?.getAttribute('style') || '';
        const m = style.match(/url\(['"]?([^'")\s]+)['"]?\)/i);
        if (m) return m[1];
      }
      return '';
    },
    getCurrentTime: () => parseClock('.playbackTimeline__timePassed span:last-child, .playbackTimeline__timePassed'),
    getDuration: () => parseClock('.playbackTimeline__duration span:last-child, .playbackTimeline__duration')
  }
];

function clickFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return true; }
  }
  return false;
}

function parseClock(selector) {
  const el = document.querySelector(selector);
  const parts = el?.textContent?.trim().split(':').map(Number);
  if (!parts || parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

class MediaController {
  constructor() {
    this.elementIds = new WeakMap();   // element -> mediaId
    this.mediaElements = new Map();    // mediaId -> element
    this.userVolumes = new Map();      // mediaId -> last user-chosen volume (fade target)
    this.pausedByExtension = new Set();
    this.activeFades = new Map();      // mediaId -> intervalId
    this._selfVol = new WeakMap();     // element -> { v, at }

    this.winnerId = null;
    this.recomputeTimer = null;
    this.lastTimeUpdate = 0;
    this.idCounter = 0;
    this._suppressEcho = null;         // { id, at }: a resume the background commanded — don't echo it

    this.site = SITE_CONTROLLERS.find(c => location.hostname.includes(c.match)) || null;

    // Site-mode state
    this.siteMediaId = null;
    this.siteReportedPlaying = false;
  }

  init() {
    browser.runtime.onMessage.addListener((msg) => this.onRuntimeMessage(msg));
    if (this.site?.detect) this.initSiteMode();
    else this.initUniversalMode();
    Logger.success(`Media controller ready on ${location.hostname} (${this.site?.detect ? 'site' : 'universal'} mode)`);
  }

  // =========================================================================
  // UNIVERSAL MODE — capture-phase element detection
  // =========================================================================

  initUniversalMode() {
    const opts = { capture: true };
    for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'loadedmetadata']) {
      document.addEventListener(type, (e) => this.onStateEvent(e), opts);
    }
    document.addEventListener('timeupdate', (e) => this.onTimeUpdate(e), opts);
    this.scheduleRecompute();
    setInterval(() => this.prune(), MC_CONFIG.PRUNE_INTERVAL);
  }

  isAudible(el) {
    return !!el && !el.muted && el.volume > 0;
  }

  isCandidate(el) {
    return el && !el.paused && !el.ended && this.isAudible(el) &&
           el.readyState >= MC_CONFIG.MIN_READY_STATE;
  }

  onStateEvent(e) {
    const el = e.target;
    if (!this.isMediaElement(el)) return;
    const id = this.elementIds.get(el);

    if (e.type === 'volumechange') {
      if (id && !this.isFading(id) && !this.isSelfVolumeChange(el) && this.isAudible(el)) {
        this.userVolumes.set(id, el.volume);
      }
    } else if (e.type === 'loadedmetadata' && id && id === this.winnerId) {
      this.emitPlay(el, id);   // new track in the same element (playlist) — refresh metadata
    }
    this.scheduleRecompute();
  }

  onTimeUpdate(e) {
    const el = e.target;
    if (!this.isMediaElement(el)) return;
    const id = this.elementIds.get(el);
    if (!id || id !== this.winnerId) return;

    const now = Date.now();
    if (now - this.lastTimeUpdate < MC_CONFIG.TIME_UPDATE_THROTTLE) return;
    this.lastTimeUpdate = now;
    this.send(AUTOSTOP.MSG.TIME_UPDATE, {
      mediaId: id,
      currentTime: el.currentTime,
      duration: this.finiteDuration(el),
      playbackRate: el.playbackRate || 1,
      title: this.getTitle(el)
    });
  }

  scheduleRecompute() {
    if (this.recomputeTimer) return;
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      this.recompute();
    }, MC_CONFIG.RECOMPUTE_DEBOUNCE);
  }

  recompute() {
    const winner = this.pickWinner();
    const newId = winner ? this.ensureRegistered(winner) : null;
    if (newId === this.winnerId) return;

    const prevId = this.winnerId;
    this.winnerId = newId;

    if (newId) {
      if (prevId && this.getElement(prevId)?.ended) {
        this.send(AUTOSTOP.MSG.MEDIA_ENDED, { mediaId: prevId });
        this.pausedByExtension.delete(prevId);
      }
      if (this._suppressEcho?.id === newId && Date.now() - this._suppressEcho.at < 2000) {
        this._suppressEcho = null;
      } else {
        this.emitPlay(winner, newId);
      }
    } else if (prevId) {
      this.emitDrop(prevId);
    }
  }

  pickWinner() {
    const candidates = [];
    for (const el of document.querySelectorAll('video, audio')) {
      if (this.isCandidate(el)) candidates.push(el);
    }
    if (candidates.length <= 1) return candidates[0] || null;
    const current = this.getElement(this.winnerId);
    if (current && candidates.includes(current)) return current;
    return candidates.reduce((best, el) => this.visibleRatio(el) > this.visibleRatio(best) ? el : best);
  }

  visibleRatio(el) {
    try {
      const r = el.getBoundingClientRect();
      const total = r.width * r.height;
      if (total <= 0) return 0;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      return (w * h) / total;
    } catch (e) {
      return 0;
    }
  }

  ensureRegistered(el) {
    let id = this.elementIds.get(el);
    if (id && this.mediaElements.has(id)) return id;
    id = `media-${Date.now()}-${++this.idCounter}`;
    this.elementIds.set(el, id);
    this.mediaElements.set(id, el);
    this.userVolumes.set(id, el.volume || 1);
    this.send(AUTOSTOP.MSG.MEDIA_REGISTERED, this.mediaInfo(el, id));
    return id;
  }

  emitPlay(el, id) {
    const info = this.mediaInfo(el, id);
    Logger.info('▶ audible winner →', info.title);
    this.send(AUTOSTOP.MSG.MEDIA_PLAY, info);
  }

  emitDrop(id) {
    const el = this.getElement(id);
    if (el?.ended) {
      Logger.info('⏹ winner ended');
      this.send(AUTOSTOP.MSG.MEDIA_ENDED, { mediaId: id });
    } else {
      const manual = !!el && el.paused && !this.pausedByExtension.has(id);
      Logger.info(`⏸ winner dropped (${manual ? 'user paused' : 'stopped/muted/gone'})`);
      this.send(AUTOSTOP.MSG.MEDIA_PAUSE, { mediaId: id, currentTime: el?.currentTime || 0, manual });
    }
    this.pausedByExtension.delete(id);
  }

  prune() {
    for (const [id, el] of this.mediaElements) {
      if (!el || !document.contains(el)) this.cleanup(id);
    }
  }

  cleanup(id) {
    this.cancelFade(id);
    this.mediaElements.delete(id);
    this.userVolumes.delete(id);
    this.pausedByExtension.delete(id);
    if (this.winnerId === id) this.winnerId = null;
    this.send(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId: id });
  }

  // =========================================================================
  // SITE MODE — poll the site's own player (e.g. SoundCloud)
  // =========================================================================

  initSiteMode() {
    this.siteMediaId = `site-${this.site.match}`;   // stable across reloads (per tab)
    setInterval(() => this.pollSite(), MC_CONFIG.SITE_POLL_INTERVAL);
    this.observeSite();   // instant response to button changes; poll is the safety net
    this.pollSite();
  }

  observeSite() {
    const target = this.site.observeSelector || '.playControls';
    const attach = () => {
      const el = document.querySelector(target);
      if (!el) { setTimeout(attach, 500); return; }
      new MutationObserver(() => this.pollSite()).observe(el, {
        attributes: true, subtree: true, attributeFilter: ['class', 'aria-label', 'title']
      });
    };
    attach();
  }

  pollSite() {
    const playing = !!this.site.isPlaying();
    const id = this.siteMediaId;

    if (playing && !this.siteReportedPlaying) {
      this.siteReportedPlaying = true;
      this.send(AUTOSTOP.MSG.MEDIA_REGISTERED, this.siteMediaInfo(id));
      if (this._suppressEcho?.id === id && Date.now() - this._suppressEcho.at < 2000) {
        this._suppressEcho = null;   // background commanded this resume; don't echo
        Logger.info('▶ site playing (commanded resume, echo suppressed)');
      } else {
        Logger.info('▶ site playing →', this.getTitle(null));
        this.send(AUTOSTOP.MSG.MEDIA_PLAY, this.siteMediaInfo(id));
      }
    } else if (!playing && this.siteReportedPlaying) {
      this.siteReportedPlaying = false;
      const manual = !this.pausedByExtension.has(id);
      this.pausedByExtension.delete(id);
      Logger.info(`⏸ site paused (${manual ? 'user' : 'by extension'})`);
      this.send(AUTOSTOP.MSG.MEDIA_PAUSE, { mediaId: id, currentTime: this.site.getCurrentTime?.() || 0, manual });
    } else if (playing) {
      const now = Date.now();
      if (now - this.lastTimeUpdate >= MC_CONFIG.TIME_UPDATE_THROTTLE) {
        this.lastTimeUpdate = now;
        this.send(AUTOSTOP.MSG.TIME_UPDATE, {
          mediaId: id,
          currentTime: this.site.getCurrentTime?.() || 0,
          duration: this.site.getDuration?.() || 0,
          playbackRate: 1,
          title: this.getTitle(null)
        });
      }
    }
  }

  siteMediaInfo(id) {
    return {
      mediaId: id,
      adapter: this.site.match.replace(/\..*$/, ''),
      title: this.getTitle(null),
      cover: this.getCover(null),
      duration: this.site.getDuration?.() || 0,
      currentTime: this.site.getCurrentTime?.() || 0,
      isPlaying: !!this.site.isPlaying(),
      hasSkip: true,
      mediaType: 'audio'
    };
  }

  // =========================================================================
  // COMMANDS FROM THE BACKGROUND (both modes)
  // =========================================================================

  onRuntimeMessage(msg) {
    if (!msg) return;
    if (msg.type === 'PING') return this.handlePing(msg.mediaId);
    if (msg.type !== AUTOSTOP.MSG.CONTROL) return;

    switch (msg.action) {
      case AUTOSTOP.ACTION.PLAY:   return this.play(msg.mediaId, msg.fade, msg.suppressEcho);
      case AUTOSTOP.ACTION.PAUSE:  return this.pause(msg.mediaId);
      case AUTOSTOP.ACTION.SKIP:   return this.skip(msg.mediaId);
      case AUTOSTOP.ACTION.PREV:   return this.prev(msg.mediaId);
      case AUTOSTOP.ACTION.SET_VOLUME: return this.setVolume(msg.mediaId, msg.volume);
    }
  }

  handlePing(mediaId) {
    if (this.site?.detect) {
      if (this.site.isPlaying()) this.send(AUTOSTOP.MSG.MEDIA_PLAY, this.siteMediaInfo(mediaId));
      else this.send(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
      return;
    }
    const el = this.getElement(mediaId);
    if (el && !el.paused && !el.ended && this.isAudible(el)) {
      this.send(AUTOSTOP.MSG.MEDIA_PLAY, this.mediaInfo(el, mediaId));
    } else {
      this.send(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
    }
  }

  play(mediaId, fade, suppressEcho) {
    if (suppressEcho) this._suppressEcho = { id: mediaId, at: Date.now() };
    this.pausedByExtension.delete(mediaId);
    Logger.info('CMD play' + (fade && fade.duration > 0 ? ` (fade ${fade.duration}ms from ${Math.round((fade.startVolume || 0) * 100)}%)` : ''));

    if (this.site?.detect) {
      // Site players (SoundCloud) resume instantly at the user's own volume. We don't ramp
      // their visible slider — we can't know the real target level, and moving it is intrusive.
      this.site.play();
      return;
    }

    const el = this.getElement(mediaId);
    if (!el) return this.send(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
    if (fade && fade.duration > 0) this.fadePlay(el, mediaId, fade);
    else { this.cancelFade(mediaId); el.play().catch(() => {}); }
  }

  pause(mediaId) {
    this.pausedByExtension.add(mediaId);
    Logger.info('CMD pause (by extension)');
    if (this.site?.detect) { this.cancelFade(mediaId); this.site.pause(); return; }

    const el = this.getElement(mediaId);
    if (!el) return this.send(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
    this.cancelFade(mediaId, true);
    el.pause();
  }

  skip(mediaId) {
    if (this.site?.next?.()) return;
    const el = this.getElement(mediaId);
    if (el && this.finiteDuration(el) > 0) el.currentTime = el.duration;
  }

  prev(mediaId) {
    if (this.site?.prev?.()) return;
    const el = this.getElement(mediaId);
    if (el && this.finiteDuration(el) > 0) el.currentTime = 0;
  }

  setVolume(mediaId, volume) {
    this.cancelFade(mediaId);
    this.userVolumes.set(mediaId, clamp01(volume));
    if (this.site?.detect) { this.site.setVolume(clamp01(volume)); return; }
    const el = this.getElement(mediaId);
    if (!el) return this.send(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
    this.setElementVolume(el, volume);
  }

  // =========================================================================
  // LOCAL FADE ENGINE (IPC-free, elapsed-time so it works in background tabs)
  // =========================================================================

  fadePlay(el, mediaId, { duration, startVolume }) {
    const target = clamp01(this.userVolumes.get(mediaId) || el.volume || 1);
    // Set the start volume (inside runFade) before play() so there's no blip at full volume.
    this.runFade(mediaId, target, startVolume, duration,
      (v) => this.setElementVolume(el, v),
      () => !document.contains(el) || el.paused || el.ended);
    el.play().catch(() => {});
  }

  runFade(mediaId, target, startVolume, duration, apply, abortIf) {
    this.cancelFade(mediaId);
    target = clamp01(target || 1);
    const start = clamp01(Math.min(startVolume ?? 0, target));
    apply(start);

    if (duration <= 0 || start >= target) { apply(target); return; }

    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      // Aborted mid-ramp (paused / ended / detached): restore the target volume so the
      // element isn't left stuck quiet for the next non-fade play.
      if (abortIf && abortIf()) { apply(target); this.cancelFade(mediaId); return; }
      const t = Math.min(1, (Date.now() - startedAt) / duration);
      apply(start + (target - start) * t);
      if (t >= 1) { apply(target); this.cancelFade(mediaId); }
    }, MC_CONFIG.FADE_STEP_MS);
    this.activeFades.set(mediaId, intervalId);
  }

  cancelFade(mediaId, restore = false) {
    const id = this.activeFades.get(mediaId);
    if (!id) return;
    clearInterval(id);
    this.activeFades.delete(mediaId);
    if (restore && !this.site?.detect) {
      const el = this.getElement(mediaId);
      if (el) this.setElementVolume(el, clamp01(this.userVolumes.get(mediaId) ?? 1));
    }
  }

  isFading(mediaId) {
    return this.activeFades.has(mediaId);
  }

  isSelfVolumeChange(el) {
    const rec = this._selfVol.get(el);
    return !!rec && Math.abs(el.volume - rec.v) < 0.02 && (Date.now() - rec.at) < MC_CONFIG.VOL_EVENT_GUARD_MS;
  }

  setElementVolume(el, v) {
    const clamped = clamp01(v);
    this._selfVol.set(el, { v: clamped, at: Date.now() });
    el.volume = clamped;
  }

  // =========================================================================
  // METADATA (Media Session API first — the most dynamic source)
  // =========================================================================

  mediaInfo(el, mediaId) {
    return {
      mediaId,
      adapter: 'generic',
      title: this.getTitle(el),
      cover: this.getCover(el),
      duration: this.finiteDuration(el),
      currentTime: el?.currentTime || 0,
      isPlaying: el ? (!el.paused && !el.ended) : false,
      hasSkip: true,
      mediaType: el?.tagName?.toLowerCase() || 'audio'
    };
  }

  getTitle(el) {
    const meta = navigator.mediaSession?.metadata;
    if (meta?.title) return meta.artist ? `${meta.artist} - ${meta.title}` : meta.title;
    if (this.site?.getTitle) { const t = this.site.getTitle(); if (t) return t; }
    if (el?.getAttribute?.('aria-label')) return el.getAttribute('aria-label');
    if (el?.title) return el.title;
    for (const sel of ['h1', '.track-title', '.trackTitle', '[class*="title"]']) {
      try { const n = document.querySelector(sel); const t = n?.textContent?.trim(); if (t) return t.substring(0, 120); } catch (e) {}
    }
    return document.title || 'Unknown Media';
  }

  getCover(el) {
    const artwork = navigator.mediaSession?.metadata?.artwork;
    if (artwork?.length) {
      const largest = artwork.reduce((best, cur) => {
        const s = parseInt(cur.sizes?.split('x')[0]) || 0;
        const b = parseInt(best.sizes?.split('x')[0]) || 0;
        return s > b ? cur : best;
      }, artwork[0]);
      if (largest?.src) return largest.src;
    }
    if (this.site?.getCover) { const c = this.site.getCover(); if (c) return c; }
    if (el?.poster) return el.poster;
    const og = document.querySelector('meta[property="og:image"]');
    if (og?.content) return og.content;
    return '';
  }

  // ===== Helpers =====

  isMediaElement(el) {
    return el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');
  }

  getElement(mediaId) {
    const el = this.mediaElements.get(mediaId);
    return el && document.contains(el) ? el : null;
  }

  finiteDuration(el) {
    const d = el?.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  send(type, data) {
    browser.runtime.sendMessage({ type, data }).catch(() => {});
  }
}

window.MediaController = MediaController;
