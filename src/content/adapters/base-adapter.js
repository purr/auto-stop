// Auto-Stop Media - Base Adapter Class
// All site-specific adapters extend this

class BaseAdapter {
  constructor() {
    this.name = 'base';
    this.mediaElements = new Map(); // mediaId -> { element, info }
    this.pausedByExtension = new Set();
    this.mediaIdCounter = 0;
  }

  /**
   * Check if this adapter should handle the current page
   * @returns {boolean}
   */
  matches() {
    return false;
  }

  /**
   * Get adapter priority (higher = checked first)
   * @returns {number}
   */
  get priority() {
    return 0;
  }

  /**
   * Initialize the adapter
   */
  init() {
    Logger.success(`${this.name} adapter initialized`);
  }

  /**
   * Generate a unique media ID
   * @returns {string}
   */
  generateMediaId() {
    return `${this.name}-${Date.now()}-${++this.mediaIdCounter}`;
  }

  /**
   * Scan for media elements on the page
   */
  scanForMedia() {
    // Override in subclass
  }

  /**
   * Get media info for an element
   * @param {HTMLMediaElement} element
   * @param {string} mediaId
   * @returns {Object}
   */
  getMediaInfo(element, mediaId) {
    return {
      mediaId,
      adapter: this.name,
      title: this.getTitle(element),
      cover: this.getCover(element),
      duration: element?.duration || 0,
      currentTime: element?.currentTime || 0,
      isPlaying: element ? (!element.paused && !element.ended) : false,
      hasSkip: this.hasSkipButton(),
      mediaType: element?.tagName?.toLowerCase() || 'audio'
    };
  }

  /**
   * Get media title
   * @param {HTMLMediaElement} element
   * @returns {string}
   */
  getTitle(element) {
    // Try Media Session API first
    if (navigator.mediaSession?.metadata?.title) {
      return navigator.mediaSession.metadata.title;
    }

    // Try element attributes
    if (element?.getAttribute('aria-label')) {
      return element.getAttribute('aria-label');
    }
    if (element?.title) {
      return element.title;
    }

    // Fallback to document title
    return document.title || 'Unknown Media';
  }

  /**
   * Get cover art URL
   * @param {HTMLMediaElement} element
   * @returns {string}
   */
  getCover(element) {
    // Try Media Session API
    if (navigator.mediaSession?.metadata?.artwork?.length > 0) {
      const artwork = navigator.mediaSession.metadata.artwork;
      const largest = artwork.reduce((prev, curr) => {
        const prevSize = parseInt(prev.sizes?.split('x')[0]) || 0;
        const currSize = parseInt(curr.sizes?.split('x')[0]) || 0;
        return currSize > prevSize ? curr : prev;
      }, artwork[0]);
      if (largest?.src) return largest.src;
    }

    // Try poster attribute
    if (element?.poster) {
      return element.poster;
    }

    // Try og:image
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage?.content) {
      return ogImage.content;
    }

    return '';
  }

  /**
   * Check if skip is available (always true - we can seek to end)
   * @returns {boolean}
   */
  hasSkipButton() {
    return true;
  }

  /**
   * Handle play action
   * @param {string} mediaId
   */
  play(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    if (stored?.element) {
      stored.element.play().catch(() => {});
    } else {
      // Fallback: element not found, try to play any paused media in the page
      Logger.warn('Element not found for mediaId:', mediaId, '- using fallback');
      this.playAnyPaused();
    }
  }

  /**
   * Fallback: play any paused media element on the page
   * Also re-registers the element so background gets updated info
   */
  playAnyPaused() {
    const mediaElements = document.querySelectorAll('video, audio');
    for (const el of mediaElements) {
      // Skip tiny elements (likely UI sounds)
      if (el.duration > 1 && el.paused && !el.ended) {
        Logger.info('Fallback: playing paused element', el.src?.substring(0, 50) || el.tagName);

        // Re-register if needed (it might have a stale or no mediaId)
        if (!el._autoStopMediaId || !this.mediaElements.has(el._autoStopMediaId)) {
          this.reRegisterElement(el);
        }

        el.play().catch(() => {});
        return true;
      }
    }

    // Also try elements that have currentSrc but aren't playing
    for (const el of mediaElements) {
      if (el.currentSrc && el.paused) {
        Logger.info('Fallback: playing element with currentSrc');

        if (!el._autoStopMediaId || !this.mediaElements.has(el._autoStopMediaId)) {
          this.reRegisterElement(el);
        }

        el.play().catch(() => {});
        return true;
      }
    }

    Logger.warn('Fallback: no paused media found to play');
    return false;
  }

  /**
   * Re-register a media element that might have been recreated
   * @param {HTMLMediaElement} element
   */
  reRegisterElement(element) {
    // This should be overridden in subclasses that have proper registration
    const mediaId = this.generateMediaId();
    element._autoStopMediaId = mediaId;

    const info = this.getMediaInfo(element, mediaId);
    this.mediaElements.set(mediaId, { element, info });

    Logger.info('Re-registered element with new mediaId:', mediaId);

    // Notify background of the new media
    this.sendMessage(AUTOSTOP.MSG.MEDIA_REGISTERED, info);

    return mediaId;
  }

  /**
   * Handle pause action
   * @param {string} mediaId
   */
  pause(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    if (stored?.element) {
      this.pausedByExtension.add(mediaId);
      stored.element.pause();
    } else {
      // Fallback: pause any playing media
      Logger.warn('Element not found for mediaId:', mediaId, '- using fallback');
      this.pauseAnyPlaying();
    }
  }

  /**
   * Fallback: pause any playing media element on the page
   */
  pauseAnyPlaying() {
    const mediaElements = document.querySelectorAll('video, audio');
    for (const el of mediaElements) {
      if (!el.paused && !el.ended) {
        Logger.info('Fallback: pausing playing element');

        // Re-register if needed
        if (!el._autoStopMediaId || !this.mediaElements.has(el._autoStopMediaId)) {
          const newMediaId = this.reRegisterElement(el);
          this.pausedByExtension.add(newMediaId);
        } else {
          this.pausedByExtension.add(el._autoStopMediaId);
        }

        el.pause();
        return true;
      }
    }

    Logger.warn('Fallback: no playing media found to pause');
    return false;
  }

  /**
   * Handle set volume action
   * @param {string} mediaId
   * @param {number} volume - 0 to 1
   */
  setVolume(mediaId, volume) {
    const clampedVolume = Math.max(0, Math.min(1, volume));
    const stored = this.mediaElements.get(mediaId);

    if (stored?.element) {
      stored.element.volume = clampedVolume;
      Logger.debug('Volume set to:', (clampedVolume * 100).toFixed(0) + '%', 'on element:', mediaId);
    } else {
      // Fallback: try to set volume on all playing media elements
      Logger.warn('Element not found for mediaId:', mediaId, '- trying fallback');
      const mediaElements = document.querySelectorAll('video, audio');
      mediaElements.forEach(el => {
        if (!el.paused) {
          el.volume = clampedVolume;
          Logger.debug('Fallback volume set on playing element');
        }
      });
    }
  }

  /**
   * Handle skip action - seeks to end of media
   * @param {string} mediaId
   */
  skip(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    let element = stored?.element;

    // Fallback: find any playing media
    if (!element) {
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
    }
  }

  /**
   * Handle previous action - seeks to start of media
   * @param {string} mediaId
   */
  prev(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    let element = stored?.element;

    // Fallback: find any playing media
    if (!element) {
      const allMedia = document.querySelectorAll('video, audio');
      for (const media of allMedia) {
        if (!media.paused && media.duration > 0) {
          element = media;
          break;
        }
      }
    }

    if (element) {
      Logger.debug('Prev: seeking to start');
      element.currentTime = 0;
    }
  }

  /**
   * Check if media was paused by extension
   * @param {string} mediaId
   * @returns {boolean}
   */
  wasPausedByExtension(mediaId) {
    return this.pausedByExtension.has(mediaId);
  }

  /**
   * Clear paused by extension flag
   * @param {string} mediaId
   */
  clearPausedFlag(mediaId) {
    this.pausedByExtension.delete(mediaId);
  }

  /**
   * Send message to background
   * @param {string} type
   * @param {Object} data
   */
  sendMessage(type, data) {
    browser.runtime.sendMessage({ type, data }).catch((e) => {
      Logger.error('Failed to send message:', e.message);
    });
  }

  /**
   * Send time update to background
   * Call this periodically when media is playing
   * @param {string} mediaId
   * @param {number} currentTime - Current playback position in seconds
   * @param {number} duration - Total duration in seconds
   * @param {number} playbackRate - Playback speed (1 = normal)
   */
  sendTimeUpdate(mediaId, currentTime, duration, playbackRate = 1) {
    this.sendMessage(AUTOSTOP.MSG.TIME_UPDATE, {
      mediaId,
      currentTime,
      duration,
      playbackRate
    });
  }
}

// Make available globally
window.BaseAdapter = BaseAdapter;

