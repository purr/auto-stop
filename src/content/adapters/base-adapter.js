// Auto-Stop Media - Base Adapter Class
// All site-specific adapters extend this

class BaseAdapter {
  constructor() {
    this.name = 'base';
    this.mediaElements = new Map(); // mediaId -> { element, info }
    this.pausedByExtension = new Set();
    this.mutedByExtension = new Set();
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
   * Check if page has skip/next button
   * @returns {boolean}
   */
  hasSkipButton() {
    return false;
  }

  /**
   * Handle play action
   * @param {string} mediaId
   */
  play(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    if (stored?.element) {
      stored.element.play().catch(() => {});
    }
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
    }
  }

  /**
   * Handle mute action
   * @param {string} mediaId
   */
  mute(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    if (stored?.element) {
      this.mutedByExtension.add(mediaId);
      stored.element.muted = true;
    }
  }

  /**
   * Handle unmute action
   * @param {string} mediaId
   */
  unmute(mediaId) {
    const stored = this.mediaElements.get(mediaId);
    if (stored?.element) {
      this.mutedByExtension.delete(mediaId);
      stored.element.muted = false;
    }
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
   * Handle skip action
   * @param {string} mediaId
   */
  skip(mediaId) {
    // Override in subclass
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
    this.mutedByExtension.delete(mediaId);
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

