// Auto-Stop Media - Generic Adapter
// Handles standard HTML5 audio/video elements

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

  init() {
    super.init();

    // Hook into HTMLMediaElement prototype
    this.hookMediaElement();

    // Initial scan
    this.scanForMedia();

    // Observe DOM for new elements
    this.observeDOM();

    // Periodic scan as backup
    setInterval(() => this.scanForMedia(), 2000);
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
        setTimeout(() => this.scanForMedia(), 100);
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

    element.addEventListener('volumechange', () => {
      if (!element.muted && this.mutedByExtension.has(mediaId)) {
        this.mutedByExtension.delete(mediaId);
        if (!element.paused) {
          this.notifyPlay(element, mediaId);
        }
      }
    });

    // Update info on metadata load
    element.addEventListener('loadedmetadata', () => {
      const stored = this.mediaElements.get(mediaId);
      if (stored) {
        stored.info = this.getMediaInfo(element, mediaId);
      }
    });

    // Send time updates to background (throttled)
    let lastTimeUpdate = 0;
    element.addEventListener('timeupdate', () => {
      const now = Date.now();
      // Send update every 500ms for smooth display
      if (now - lastTimeUpdate > 500) {
        lastTimeUpdate = now;
        this.sendMessage(AUTOSTOP.MSG.TIME_UPDATE, {
          mediaId,
          currentTime: element.currentTime,
          duration: element.duration || 0,
          playbackRate: element.playbackRate || 1
        });
      }
    });
  }

  notifyPlay(element, mediaId) {
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
    const selectors = [
      '[class*="next"]',
      '[class*="skip"]',
      '[aria-label*="next" i]',
      '[aria-label*="skip" i]'
    ];

    for (const selector of selectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn && !btn.disabled) return true;
      } catch (e) {}
    }

    return false;
  }

  skip(mediaId) {
    const stored = this.mediaElements.get(mediaId);

    // Try to find and click skip button
    const selectors = [
      '.next-button',
      '.skip-button',
      '[aria-label="Next"]',
      '[aria-label="Skip"]'
    ];

    for (const selector of selectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn && !btn.disabled) {
          btn.click();
          return;
        }
      } catch (e) {}
    }

    // Fallback: seek to end
    if (stored?.element?.duration && isFinite(stored.element.duration)) {
      stored.element.currentTime = stored.element.duration;
    }
  }
}

// Make available globally
window.GenericAdapter = GenericAdapter;

