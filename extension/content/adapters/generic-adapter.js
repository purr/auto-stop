// Auto-Stop Media - Generic Adapter
// Handles standard HTML5 audio/video elements

// =============================================================================
// CONFIGURATION - Easy to modify values
// =============================================================================
const GENERIC_ADAPTER_CONFIG = {
  SCAN_INTERVAL: 2000,           // How often to scan for new media elements (ms)
  HEALTH_CHECK_INTERVAL: 1000,   // How often to run health check (ms)
  DOM_MUTATION_DELAY: 100,       // Delay after DOM mutation before scanning (ms)
  TIME_UPDATE_THROTTLE: 500      // Minimum time between time update messages (ms)
};

class GenericAdapter extends BaseAdapter {
  constructor() {
    super();
    this.name = 'generic';
  }

  matches() {
    // Generic adapter is the fallback - always matches
    return true;
  }

  get priority() {
    return 0; // Lowest priority - used as fallback
  }

  /**
   * Check if a media element has audible sound
   * Returns false for muted elements or elements with zero volume
   */
  hasAudio(element) {
    if (!element) return false;
    // Muted elements don't count
    if (element.muted) return false;
    // Zero volume doesn't count
    if (element.volume === 0) return false;
    return true;
  }

  init() {
    super.init();

    // Hook into HTMLMediaElement prototype
    this.hookMediaElement();

    // Initial scan
    this.scanForMedia();

    // Observe DOM for new elements
    this.observeDOM();

    // Periodic scan as backup (registers new elements)
    setInterval(() => this.scanForMedia(), GENERIC_ADAPTER_CONFIG.SCAN_INTERVAL);

    // Periodic health check (validates tracked elements, syncs playing state)
    setInterval(() => this.healthCheck(), GENERIC_ADAPTER_CONFIG.HEALTH_CHECK_INTERVAL);
  }

  hookMediaElement() {
    const self = this;
    const originalPlay = HTMLMediaElement.prototype.play;

    HTMLMediaElement.prototype.play = function() {
      // Register if not already
      if (!this._autoStopMediaId && !this._autoStopIgnore) {
        self.registerMediaElement(this);
      }
      return originalPlay.apply(this, arguments);
    };
  }

  observeDOM() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' ||
                node.querySelector?.('video, audio')) {
              shouldScan = true;
              break;
            }
          }
        }
        if (shouldScan) break;
      }
      if (shouldScan) {
        setTimeout(() => this.scanForMedia(), GENERIC_ADAPTER_CONFIG.DOM_MUTATION_DELAY);
      }
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }
  }

  scanForMedia() {
    const elements = document.querySelectorAll('video, audio');

    for (const element of elements) {
      if (!element._autoStopMediaId && !element._autoStopIgnore) {
        this.registerMediaElement(element);
      }
    }
  }

  /**
   * Periodic health check to keep tracking in sync
   * - Removes stale entries (elements no longer in DOM)
   * - Detects playing media we might have lost track of
   * - Sends heartbeat for currently playing media
   */
  healthCheck() {
    // 1. Clean up stale entries (elements no longer in DOM or invalid)
    for (const [mediaId, stored] of this.mediaElements.entries()) {
      const element = stored.element;

      // Check if element is still in DOM and valid
      if (!element || !document.contains(element)) {
        Logger.debug('Health check: removing stale entry', mediaId);
        this.mediaElements.delete(mediaId);
        this.pausedByExtension.delete(mediaId);
        // Notify background that this media is gone
        this.sendMessage(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
        continue;
      }
    }

    // 2. Find any playing media WITH AUDIO in the page
    const allMedia = document.querySelectorAll('video, audio');
    let foundPlaying = false;

    for (const element of allMedia) {
      // Only consider media that is playing, has duration, AND has audio
      if (!element.paused && !element.ended && element.duration > 1 && this.hasAudio(element)) {
        foundPlaying = true;

        // Check if we're tracking this element
        const mediaId = element._autoStopMediaId;

        if (!mediaId || !this.mediaElements.has(mediaId)) {
          // We have playing media that we're not tracking!
          Logger.warn('Health check: found untracked playing media with audio, registering');
          this.registerMediaElement(element);
          // The registration will send MEDIA_PLAY if it's playing
        } else {
          // We're tracking it - send a heartbeat to confirm it's still playing
          const info = this.getMediaInfo(element, mediaId);
          if (info.isPlaying) {
            // Send play event to ensure background is in sync
            this.sendMessage(AUTOSTOP.MSG.MEDIA_PLAY, info);
          }
        }
      }
    }

    // 3. If no media is playing, check if background thinks something is
    // This is handled by the background receiving no heartbeats
  }

  registerMediaElement(element) {
    // Skip very small elements (likely UI sounds)
    // But allow elements with src set
    if (!element.src && !element.querySelector('source')) {
      return;
    }

    const mediaId = this.generateMediaId();
    element._autoStopMediaId = mediaId;

    const info = this.getMediaInfo(element, mediaId);
    this.mediaElements.set(mediaId, { element, info });

    // Set up event listeners
    this.setupEventListeners(element, mediaId);

    // Notify background
    this.sendMessage(AUTOSTOP.MSG.MEDIA_REGISTERED, info);

    Logger.media('Generic registered', { mediaId, src: element.src?.substring(0, 50) });

    // If already playing, notify
    if (!element.paused && !element.ended) {
      this.notifyPlay(element, mediaId);
    }
  }

  /**
   * Re-register a media element (override from base for full event setup)
   * @param {HTMLMediaElement} element
   */
  reRegisterElement(element) {
    // Clean up old registration if exists
    if (element._autoStopMediaId) {
      this.mediaElements.delete(element._autoStopMediaId);
    }

    const mediaId = this.generateMediaId();
    element._autoStopMediaId = mediaId;

    const info = this.getMediaInfo(element, mediaId);
    this.mediaElements.set(mediaId, { element, info });

    // Set up event listeners (they stack but that's okay - browser handles it)
    this.setupEventListeners(element, mediaId);

    // Notify background
    this.sendMessage(AUTOSTOP.MSG.MEDIA_REGISTERED, info);

    Logger.info('Re-registered generic element with new mediaId:', mediaId);

    return mediaId;
  }

  setupEventListeners(element, mediaId) {
    element.addEventListener('play', () => {
      this.clearPausedFlag(mediaId);
      this.notifyPlay(element, mediaId);
    });

    element.addEventListener('playing', () => {
      this.notifyPlay(element, mediaId);
    });

    element.addEventListener('pause', () => {
      const wasManual = !this.wasPausedByExtension(mediaId);
      this.sendMessage(AUTOSTOP.MSG.MEDIA_PAUSE, {
        mediaId,
        currentTime: element.currentTime,
        manual: wasManual
      });
    });

    element.addEventListener('ended', () => {
      this.sendMessage(AUTOSTOP.MSG.MEDIA_ENDED, { mediaId });
    });

    // Update info on metadata load
    element.addEventListener('loadedmetadata', () => {
      const stored = this.mediaElements.get(mediaId);
      if (stored) {
        stored.info = this.getMediaInfo(element, mediaId);
      }
    });

    // Send time updates to background (throttled) - only if has audio
    let lastTimeUpdate = 0;
    element.addEventListener('timeupdate', () => {
      // Only send updates for media with audio
      if (!this.hasAudio(element)) return;

      const now = Date.now();
      // Throttle time updates for smooth display
      if (now - lastTimeUpdate > GENERIC_ADAPTER_CONFIG.TIME_UPDATE_THROTTLE) {
        lastTimeUpdate = now;
        this.sendMessage(AUTOSTOP.MSG.TIME_UPDATE, {
          mediaId,
          currentTime: element.currentTime,
          duration: element.duration || 0,
          playbackRate: element.playbackRate || 1
        });
      }
    });

    // Detect when muted media becomes unmuted and starts making sound
    element.addEventListener('volumechange', () => {
      if (!element.paused && !element.ended && this.hasAudio(element)) {
        Logger.debug('Media unmuted/volume increased while playing, notifying');
        this.notifyPlay(element, mediaId);
      }
    });
  }

  notifyPlay(element, mediaId) {
    // Only notify if media has audio (not muted, volume > 0)
    if (!this.hasAudio(element)) {
      Logger.debug('Skipping play notification for muted/silent media');
      return;
    }
    const info = this.getMediaInfo(element, mediaId);
    this.sendMessage(AUTOSTOP.MSG.MEDIA_PLAY, info);
  }

  getTitle(element) {
    // Try site-specific selectors first
    const selectors = [
      'h1',
      '.video-title',
      '.player-title',
      '.track-title',
      '.song-name',
      '[class*="title"]'
    ];

    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el?.textContent?.trim()) {
          return el.textContent.trim().substring(0, 100);
        }
      } catch (e) {}
    }

    return super.getTitle(element);
  }

  getCover(element) {
    const cover = super.getCover(element);
    if (cover) return cover;

    // Try common selectors
    const selectors = [
      '.album-art img',
      '.cover img',
      '.thumbnail img',
      '[class*="cover"] img',
      '[class*="artwork"] img'
    ];

    for (const selector of selectors) {
      try {
        const img = document.querySelector(selector);
        if (img?.src) return img.src;
      } catch (e) {}
    }

    return '';
  }

  hasSkipButton() {
    // Skip is always available - we seek to end
    return true;
  }

  skip(mediaId) {
    // Find the media element
    let element = null;
    const stored = this.mediaElements.get(mediaId);

    if (stored?.element) {
      element = stored.element;
    } else {
      // Fallback: find any playing media
      const allMedia = document.querySelectorAll('video, audio');
      for (const media of allMedia) {
        if (!media.paused && media.duration > 0) {
          element = media;
          break;
        }
      }
    }

    if (element && isFinite(element.duration) && element.duration > 0) {
      Logger.debug('Skip: seeking to end', element.duration);
      element.currentTime = element.duration;
    } else {
      Logger.debug('Skip: no valid media element found');
    }
  }
}

// Make available globally
window.GenericAdapter = GenericAdapter;

