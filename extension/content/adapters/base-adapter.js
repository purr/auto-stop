// Auto-Stop Media - Base Adapter Class
// All site-specific adapters extend this

class BaseAdapter {
  constructor() {
    this.name = 'base';
    this.mediaElements = new Map(); // mediaId -> { element, info }
    this.pausedByExtension = new Set();
    this.mediaIdCounter = 0;
    // Track when we're setting volume ourselves to prevent feedback loops
    this.volumeChangeFromExtension = new WeakSet(); // Set of elements we're currently setting volume on
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
    if (stored?.element && document.contains(stored.element)) {
      stored.element.play().catch(() => {});
    } else {
      // Media element doesn't exist - notify background to clean up
      Logger.warn('Element not found for mediaId:', mediaId, '- media may have been cleaned up (scrolled away)');
      // Notify background that this mediaId is stale
      this.sendMessage(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
      // Don't use fallback - it causes issues with stale mediaIds
    }
  }

  /**
   * Fallback: play any paused media element on the page
   * Also re-registers the element so background gets updated info
   * NOTE: This is deprecated - we don't use fallbacks anymore to prevent feedback loops
   */
  playAnyPaused() {
    // Don't use fallback - it causes issues with stale mediaIds and feedback loops
    Logger.debug('Fallback playAnyPaused called but disabled to prevent feedback loops');
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
    if (stored?.element && document.contains(stored.element)) {
      this.pausedByExtension.add(mediaId);
      stored.element.pause();
    } else {
      // Media element doesn't exist - notify background to clean up
      Logger.warn('Element not found for mediaId:', mediaId, '- media may have been cleaned up (scrolled away)');
      // Notify background that this mediaId is stale
      this.sendMessage(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
      // Don't use fallback - it causes issues with stale mediaIds
    }
  }

  /**
   * Fallback: pause any playing media element on the page
   * NOTE: This is deprecated - we don't use fallbacks anymore to prevent feedback loops
   */
  pauseAnyPlaying() {
    // Don't use fallback - it causes issues with stale mediaIds and feedback loops
    Logger.debug('Fallback pauseAnyPlaying called but disabled to prevent feedback loops');
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

    if (stored?.element && document.contains(stored.element)) {
      // Mark that we're setting volume to prevent feedback loops
      if (this.volumeChangeFromExtension) {
        this.volumeChangeFromExtension.add(stored.element);
      }
      stored.element.volume = clampedVolume;
      Logger.debug('Volume set to:', (clampedVolume * 100).toFixed(0) + '%', 'on element:', mediaId);

      // Clear the flag after a short delay to allow the volumechange event to fire
      setTimeout(() => {
        if (this.volumeChangeFromExtension && stored.element) {
          this.volumeChangeFromExtension.delete(stored.element);
        }
      }, 100);
    } else {
      // Media element doesn't exist or was removed - notify background to clean up
      Logger.warn('Element not found for mediaId:', mediaId, '- media may have been cleaned up (scrolled away)');
      // Notify background that this mediaId is stale
      this.sendMessage(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
      // Don't set volume on random elements - this causes feedback loops
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

