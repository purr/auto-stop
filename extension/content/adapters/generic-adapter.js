// Auto-Stop Media - Generic Adapter
// Handles standard HTML5 audio/video elements

// =============================================================================
// CONFIGURATION - Easy to modify values
// =============================================================================
const GENERIC_ADAPTER_CONFIG = {
  SCAN_INTERVAL: 1000,           // How often to scan for new media elements (ms) - more frequent for TikTok
  HEALTH_CHECK_INTERVAL: 300,    // How often to run health check (ms) - more frequent to catch TikTok videos and clean up stale media
  DOM_MUTATION_DELAY: 50,        // Delay after DOM mutation before scanning (ms) - faster for TikTok
  TIME_UPDATE_THROTTLE: 500,     // Minimum time between time update messages (ms)
  PLAY_EVENT_DEBOUNCE: 200,      // Minimum time media must play before sending play event (ms) - reduced for TikTok responsiveness
  VISIBILITY_THRESHOLD: 0.5      // Minimum portion of element that must be visible (0-1) to be considered active
};

class GenericAdapter extends BaseAdapter {
  constructor() {
    super();
    this.name = 'generic';
    // Track play event timers to debounce rapid play events
    this.playEventTimers = new Map(); // mediaId -> { timeoutId, startTime }
    // Track recently paused media to prevent immediate re-activation
    this.recentlyPausedMedia = new Map(); // mediaId -> pausedAt timestamp
    // Track the currently visible/active media element (for TikTok scrolling)
    this.currentVisibleMedia = null; // mediaId of the visible playing video
    // Throttle scan operations to prevent spam during rapid scrolling
    this.scanThrottleTimer = null;
    // Track when we're setting volume ourselves to prevent feedback loops
    this.volumeChangeFromExtension = new WeakSet(); // Set of elements we're currently setting volume on
    // Debounce volumechange events to prevent spam
    this.volumeChangeTimers = new Map(); // mediaId -> timeoutId
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

  /**
   * Check if a media element is visible in the viewport
   * Returns true if the element is actually visible and in view
   * This is critical for TikTok where multiple videos exist in DOM but only one is visible
   */
  isElementVisible(element) {
    if (!element || !document.contains(element)) return false;

    try {
      const rect = element.getBoundingClientRect();
      const windowHeight = window.innerHeight || document.documentElement.clientHeight;
      const windowWidth = window.innerWidth || document.documentElement.clientWidth;

      // Element must have dimensions
      if (rect.width === 0 || rect.height === 0) return false;

      // Calculate visible area
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(windowHeight, rect.bottom);
      const visibleLeft = Math.max(0, rect.left);
      const visibleRight = Math.min(windowWidth, rect.right);

      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const visibleArea = visibleHeight * visibleWidth;
      const totalArea = rect.width * rect.height;

      // Element must be at least VISIBILITY_THRESHOLD visible
      if (totalArea === 0) return false;
      const visibilityRatio = visibleArea / totalArea;

      return visibilityRatio >= GENERIC_ADAPTER_CONFIG.VISIBILITY_THRESHOLD;
    } catch (e) {
      // If we can't calculate visibility, assume visible (fallback)
      Logger.debug('Visibility check failed, assuming visible:', e);
      return true;
    }
  }

  /**
   * Find the currently visible playing media element
   * Returns the mediaId of the visible playing video, or null
   */
  findVisiblePlayingMedia() {
    const allMedia = document.querySelectorAll('video, audio');
    let bestCandidate = null;
    let bestVisibility = 0;

    for (const element of allMedia) {
      if (!element.paused && !element.ended && this.hasAudio(element)) {
        const isValidDuration = element.duration > 0 || element.readyState >= 2;
        if (!isValidDuration) continue;

        const visibility = this.calculateVisibilityRatio(element);
        if (visibility > bestVisibility && visibility >= GENERIC_ADAPTER_CONFIG.VISIBILITY_THRESHOLD) {
          bestVisibility = visibility;
          bestCandidate = element;
        }
      }
    }

    return bestCandidate ? bestCandidate._autoStopMediaId : null;
  }

  /**
   * Calculate visibility ratio for an element (0-1)
   */
  calculateVisibilityRatio(element) {
    try {
      const rect = element.getBoundingClientRect();
      const windowHeight = window.innerHeight || document.documentElement.clientHeight;
      const windowWidth = window.innerWidth || document.documentElement.clientWidth;

      if (rect.width === 0 || rect.height === 0) return 0;

      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(windowHeight, rect.bottom);
      const visibleLeft = Math.max(0, rect.left);
      const visibleRight = Math.min(windowWidth, rect.right);

      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const visibleArea = visibleHeight * visibleWidth;
      const totalArea = rect.width * rect.height;

      return totalArea > 0 ? visibleArea / totalArea : 0;
    } catch (e) {
      return 0;
    }
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
        // Throttle scans during rapid scrolling
        if (this.scanThrottleTimer) {
          clearTimeout(this.scanThrottleTimer);
        }
        this.scanThrottleTimer = setTimeout(() => {
          this.scanForMedia();
          this.scanThrottleTimer = null;
        }, GENERIC_ADAPTER_CONFIG.DOM_MUTATION_DELAY);
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
        // For TikTok-like sites: only register visible media or media that's playing
        // This prevents registering all videos in the scroll list
        const isPlaying = !element.paused && !element.ended;
        const isVisible = this.isElementVisible(element);

        // Register if: playing OR visible (to catch videos that are about to play)
        if (isPlaying || isVisible) {
          this.registerMediaElement(element);
        }
      }
    }
  }

  /**
   * Periodic health check to keep tracking in sync
   * - Removes stale entries (elements no longer in DOM or not visible)
   * - Detects playing media we might have lost track of
   * - Sends heartbeat for currently playing media
   * - CRITICAL: Only tracks the visible playing video (fixes TikTok scrolling issue)
   */
  healthCheck() {
    const now = Date.now();

    // 1. Find the currently visible playing media (only ONE at a time)
    const visiblePlayingMediaId = this.findVisiblePlayingMedia();

    // 2. Clean up stale entries and non-visible media
    for (const [mediaId, stored] of this.mediaElements.entries()) {
      const element = stored.element;

      // Check if element is still in DOM
      if (!element || !document.contains(element)) {
        Logger.debug('Health check: removing stale entry (not in DOM)', mediaId);
        this.cleanupMedia(mediaId);
        continue;
      }

      // For TikTok: unregister media that's scrolled away and not playing
      // Only keep the visible playing video registered
      const isPlaying = !element.paused && !element.ended;
      const isVisible = this.isElementVisible(element);
      const isCurrentVisible = mediaId === visiblePlayingMediaId;

      // Unregister if:
      // - Not visible AND not playing AND not the current visible media
      // This prevents keeping track of scrolled-away videos
      if (!isVisible && !isPlaying && !isCurrentVisible) {
        Logger.debug('Health check: removing non-visible, non-playing media (scrolled away)', mediaId);
        this.cleanupMedia(mediaId);
        continue;
      }

      // If this media is playing but not visible, and there's a visible playing media, unregister it
      // This handles the case where an old video is still playing but scrolled away
      if (isPlaying && !isVisible && visiblePlayingMediaId && visiblePlayingMediaId !== mediaId) {
        Logger.debug('Health check: removing scrolled-away playing media (new visible video exists)', mediaId);
        // Pause it first to stop playback
        element.pause();
        this.cleanupMedia(mediaId);
        continue;
      }
    }

    // 3. Clean up expired recently paused entries
    for (const [mediaId, pausedAt] of this.recentlyPausedMedia.entries()) {
      if (now - pausedAt > 2000) {
        this.recentlyPausedMedia.delete(mediaId);
      }
    }

    // 4. Register visible playing media if not already tracked
    if (visiblePlayingMediaId) {
      // Find element by checking all media elements
      let foundElement = null;
      const allMedia = document.querySelectorAll('video, audio');
      for (const el of allMedia) {
        if (el._autoStopMediaId === visiblePlayingMediaId) {
          foundElement = el;
          break;
        }
      }

      if (foundElement) {
        const mediaId = foundElement._autoStopMediaId;

        // Skip if this media was recently paused
        if (this.recentlyPausedMedia.has(mediaId)) {
          const pausedAt = this.recentlyPausedMedia.get(mediaId);
          if (now - pausedAt < 500) {
            Logger.debug('Health check: skipping recently paused visible media:', mediaId);
            return;
          }
        }

        // Update current visible media tracking
        if (this.currentVisibleMedia !== mediaId) {
          Logger.debug('Health check: visible playing media changed:', mediaId);
          this.currentVisibleMedia = mediaId;
        }

        // Ensure it's registered
        if (!this.mediaElements.has(mediaId)) {
          Logger.warn('Health check: visible playing media not registered, registering now');
          this.registerMediaElement(foundElement);
        } else {
          // Already tracked - send heartbeat if needed
          const stored = this.mediaElements.get(mediaId);
          if (stored && stored.element === foundElement) {
            if (!this.playEventTimers.has(mediaId)) {
              const info = this.getMediaInfo(foundElement, mediaId);
              this.sendMessage(AUTOSTOP.MSG.MEDIA_PLAY, info);
            }
          }
        }
      }
    } else {
      // No visible playing media - clear tracking
      if (this.currentVisibleMedia) {
        Logger.debug('Health check: no visible playing media, clearing current visible media');
        this.currentVisibleMedia = null;
      }
    }
  }

  /**
   * Clean up a media entry completely
   */
  cleanupMedia(mediaId) {
    this.mediaElements.delete(mediaId);
    this.pausedByExtension.delete(mediaId);
    this.playEventTimers.delete(mediaId);
    this.recentlyPausedMedia.delete(mediaId);
    // Clear volume change timer
    const volumeTimer = this.volumeChangeTimers.get(mediaId);
    if (volumeTimer) {
      clearTimeout(volumeTimer);
      this.volumeChangeTimers.delete(mediaId);
    }
    if (this.currentVisibleMedia === mediaId) {
      this.currentVisibleMedia = null;
    }
    // Notify background that this media is gone
    this.sendMessage(AUTOSTOP.MSG.MEDIA_UNREGISTERED, { mediaId });
  }

  registerMediaElement(element) {
    // More lenient registration - allow videos that are playing even without src yet (TikTok case)
    // TikTok videos might not have src immediately but are already playing
    const isPlaying = !element.paused && !element.ended;
    const hasSource = element.src || element.querySelector('source') || element.currentSrc;
    const isVisible = this.isElementVisible(element);

    // Register if: has source OR is currently playing OR is visible
    // But skip if element is not visible and not playing (scrolled away)
    if (!hasSource && !isPlaying && !isVisible) {
      Logger.debug('Skipping registration: element has no source, not playing, and not visible');
      return;
    }

    // If there's already a visible playing media and this one isn't visible, skip it
    // This prevents registering scrolled-away videos
    if (this.currentVisibleMedia && !isVisible && isPlaying) {
      const currentElement = Array.from(this.mediaElements.values())
        .find(stored => stored.element?._autoStopMediaId === this.currentVisibleMedia)?.element;

      if (currentElement && this.isElementVisible(currentElement)) {
        Logger.debug('Skipping registration: another visible video is already playing');
        return;
      }
    }

    const mediaId = this.generateMediaId();
    element._autoStopMediaId = mediaId;

    const info = this.getMediaInfo(element, mediaId);
    this.mediaElements.set(mediaId, { element, info });

    // Set up event listeners
    this.setupEventListeners(element, mediaId);

    // Notify background immediately
    this.sendMessage(AUTOSTOP.MSG.MEDIA_REGISTERED, info);

    Logger.media('Generic registered', { mediaId, src: element.src?.substring(0, 50) || element.currentSrc?.substring(0, 50) || 'no-src', playing: isPlaying, visible: isVisible });

    // If already playing and visible, notify immediately if it has audio
    if (isPlaying && isVisible && this.hasAudio(element)) {
      // Update current visible media
      this.currentVisibleMedia = mediaId;

      // For TikTok: if this is the only visible playing media, send immediately
      // Otherwise debounce to prevent spam from rapid scrolling
      const otherVisiblePlaying = Array.from(this.mediaElements.values()).some(
        stored => stored.element !== element &&
                  stored.element &&
                  !stored.element.paused &&
                  !stored.element.ended &&
                  this.isElementVisible(stored.element) &&
                  this.hasAudio(stored.element)
      );

      if (!otherVisiblePlaying) {
        // Only one visible playing media - send immediately for better responsiveness
        this.notifyPlay(element, mediaId);
      } else {
        // Multiple visible media - debounce to prevent spam
        this.notifyPlayDebounced(element, mediaId);
      }
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
      // Only handle if element is visible (prevents handling scrolled-away videos)
      if (!this.isElementVisible(element)) {
        Logger.debug('Ignoring play event from non-visible element:', mediaId);
        return;
      }

      this.clearPausedFlag(mediaId);
      // Debounce play events to prevent spam from rapid scrolling
      this.notifyPlayDebounced(element, mediaId);
    });

    element.addEventListener('playing', () => {
      // Only handle if element is visible (prevents handling scrolled-away videos)
      if (!this.isElementVisible(element)) {
        Logger.debug('Ignoring playing event from non-visible element:', mediaId);
        return;
      }

      // Debounce play events to prevent spam from rapid scrolling
      this.notifyPlayDebounced(element, mediaId);
    });

    element.addEventListener('pause', () => {
      // Cancel any pending play event for this media
      this.cancelPlayEvent(mediaId);

      // Mark as recently paused to prevent immediate re-activation
      this.recentlyPausedMedia.set(mediaId, Date.now());

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

    // Send time updates to background (throttled) - only if has audio and is visible
    let lastTimeUpdate = 0;
    element.addEventListener('timeupdate', () => {
      // Only send updates for media with audio and that is visible
      if (!this.hasAudio(element)) return;
      if (!this.isElementVisible(element)) return;

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
    // BUT: ignore volume changes that we caused ourselves (prevents feedback loops)
    element.addEventListener('volumechange', () => {
      // Skip if this volume change was caused by the extension (prevents feedback loop)
      if (this.volumeChangeFromExtension && this.volumeChangeFromExtension.has(element)) {
        Logger.debug('Ignoring volumechange event - caused by extension');
        return;
      }

      // Debounce volumechange events to prevent spam (especially during fade-in)
      const existingTimer = this.volumeChangeTimers.get(mediaId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timerId = setTimeout(() => {
        this.volumeChangeTimers.delete(mediaId);

        // Double-check element is still valid and extension didn't set volume
        if (this.volumeChangeFromExtension && this.volumeChangeFromExtension.has(element)) {
          Logger.debug('Ignoring debounced volumechange - caused by extension');
          return;
        }

        // Only notify if media is playing, has audio, and is visible
        if (!element.paused && !element.ended && this.hasAudio(element) && this.isElementVisible(element)) {
          Logger.debug('Media unmuted/volume increased while playing, notifying');
          this.notifyPlayDebounced(element, mediaId);
        }
      }, 300); // 300ms debounce for volume changes

      this.volumeChangeTimers.set(mediaId, timerId);
    });
  }

  /**
   * Cancel any pending play event for a media element
   */
  cancelPlayEvent(mediaId) {
    const timer = this.playEventTimers.get(mediaId);
    if (timer) {
      clearTimeout(timer.timeoutId);
      this.playEventTimers.delete(mediaId);
    }
  }

  /**
   * Debounced play notification - only sends play event if media plays for a meaningful duration
   * This prevents spam from rapid scrolling where videos briefly start playing
   */
  notifyPlayDebounced(element, mediaId) {
    // Only notify if media has audio (not muted, volume > 0)
    if (!this.hasAudio(element)) {
      Logger.debug('Skipping play notification for muted/silent media');
      return;
    }

    // CRITICAL: Only notify if media is visible (fixes TikTok scrolling issue)
    if (!this.isElementVisible(element)) {
      Logger.debug('Skipping play notification for non-visible media (scrolled away):', mediaId);
      return;
    }

    // Skip if this media was recently paused (within last 500ms - reduced for TikTok responsiveness)
    if (this.recentlyPausedMedia.has(mediaId)) {
      const pausedAt = this.recentlyPausedMedia.get(mediaId);
      if (Date.now() - pausedAt < 500) {
        Logger.debug('Skipping play notification for recently paused media:', mediaId);
        return;
      }
    }

    // Cancel any existing timer for this media
    this.cancelPlayEvent(mediaId);

    // Set a new timer - only send play event if media is still playing after debounce period
    const startTime = Date.now();
    const timeoutId = setTimeout(() => {
      // Verify media is still playing, has audio, and is visible
      if (!element || element.paused || element.ended || !this.hasAudio(element) || !this.isElementVisible(element)) {
        Logger.debug('Play event cancelled - media stopped, muted, or scrolled away during debounce');
        this.playEventTimers.delete(mediaId);
        return;
      }

      // Double-check it wasn't recently paused (reduced window)
      if (this.recentlyPausedMedia.has(mediaId)) {
        const pausedAt = this.recentlyPausedMedia.get(mediaId);
        if (Date.now() - pausedAt < 500) {
          Logger.debug('Play event cancelled - media was paused during debounce');
          this.playEventTimers.delete(mediaId);
          return;
        }
      }

      // Update current visible media
      this.currentVisibleMedia = mediaId;

      // Media has been playing for the debounce period - send play event
      const info = this.getMediaInfo(element, mediaId);
      Logger.debug('Sending debounced play event for:', mediaId, 'after', Date.now() - startTime, 'ms');
      this.sendMessage(AUTOSTOP.MSG.MEDIA_PLAY, info);
      this.playEventTimers.delete(mediaId);
    }, GENERIC_ADAPTER_CONFIG.PLAY_EVENT_DEBOUNCE);

    this.playEventTimers.set(mediaId, { timeoutId, startTime });
  }

  /**
   * Immediate play notification (used when we're sure it's a real play event)
   */
  notifyPlay(element, mediaId) {
    // Only notify if media has audio (not muted, volume > 0)
    if (!this.hasAudio(element)) {
      Logger.debug('Skipping play notification for muted/silent media');
      return;
    }

    // CRITICAL: Only notify if media is visible (fixes TikTok scrolling issue)
    if (!this.isElementVisible(element)) {
      Logger.debug('Skipping play notification for non-visible media (scrolled away):', mediaId);
      return;
    }

    // Update current visible media
    this.currentVisibleMedia = mediaId;

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

