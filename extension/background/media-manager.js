// Auto-Stop Media - Media Manager
// Manages media state across all tabs and desktop apps

// =============================================================================
// CONFIGURATION - Easy to modify values
// =============================================================================
const MEDIA_MANAGER_CONFIG = {
  STALE_CHECK_INTERVAL: 3000,    // How often to check for stale active media (ms)
  STALE_THRESHOLD: 5000,         // How long without heartbeat before media is stale (ms)
  RAPID_PLAY_COOLDOWN: 300,      // Per-media cooldown between play events (ms)
  SCROLL_COOLDOWN: 1500          // Don't stack the previous media if new media starts on the same tab within this window (ms) - TikTok scrolling
};

class MediaManager {
  constructor() {
    // Currently active media (browser OR desktop)
    this.activeMedia = null;

    // Stack of paused media (most recent first)
    // Each item has: { ...mediaInfo, manuallyPaused: boolean }
    this.pausedStack = [];

    // All known media elements (browser only)
    this.allMedia = new Map(); // key: `${tabId}-${frameId}-${mediaId}`

    // Resume state management
    this.pendingResume = null; // { timeoutId, media }

    // Desktop connector (initialized in index.js)
    this.desktopConnector = null;

    // Track recent play events to prevent spam from rapid scrolling
    this.recentPlayEvents = new Map(); // mediaId -> timestamp
    this.lastPlayEventTime = 0; // Timestamp of last play event handled

    // Start periodic stale check
    this.startStaleCheck();
  }

  /**
   * Set the desktop connector reference
   */
  setDesktopConnector(connector) {
    this.desktopConnector = connector;
  }

  /**
   * Check if a media item is desktop media
   */
  isDesktopMedia(media) {
    return media && (media.isDesktop || (media.mediaId && media.mediaId.startsWith('desktop-')));
  }

  /**
   * Start periodic check for stale active media
   */
  startStaleCheck() {
    setInterval(() => {
      this.checkForStaleMedia();
    }, MEDIA_MANAGER_CONFIG.STALE_CHECK_INTERVAL);
  }

  /**
   * Check if active media is stale (no heartbeat for too long)
   */
  checkForStaleMedia() {
    if (!this.activeMedia) return;

    // Don't check desktop media staleness - handled by connector
    if (this.isDesktopMedia(this.activeMedia)) return;

    const now = Date.now();
    const lastHeartbeat = this.activeMedia.lastHeartbeat || this.activeMedia.startedAt || now;
    const staleDuration = now - lastHeartbeat;

    if (staleDuration > MEDIA_MANAGER_CONFIG.STALE_THRESHOLD) {
      Logger.warn('Active media appears stale (no heartbeat for', Math.round(staleDuration / 1000), 'seconds)');
      this.pingActiveMedia();
    }
  }

  /**
   * Ping the active media's tab to verify it's still playing
   */
  async pingActiveMedia() {
    if (!this.activeMedia) return;
    if (this.isDesktopMedia(this.activeMedia)) return;

    const { tabId, frameId, mediaId } = this.activeMedia;

    try {
      await this.sendToFrame(tabId, frameId, {
        type: 'PING',
        mediaId,
        frameId
      });
    } catch (e) {
      Logger.warn('Cannot reach active media tab, clearing active media');
      const stoppedMedia = { ...this.activeMedia };
      this.activeMedia = null;
      this.broadcastUpdate();
      await this.scheduleResumePrevious(null, stoppedMedia);
    }
  }

  /**
   * Generate a unique key for media
   */
  getMediaKey(tabId, frameId, mediaId) {
    return `${tabId}-${frameId}-${mediaId}`;
  }

  // Identity by the full (tab, frame, mediaId) tuple. mediaId alone is not unique — site-mode
  // content (e.g. SoundCloud) uses a per-site id, so two tabs on the same site share one.
  isSameMedia(a, b) {
    return !!a && !!b && a.tabId === b.tabId && a.frameId === b.frameId && a.mediaId === b.mediaId;
  }

  // Send a command to the exact frame that owns the media. Without frame targeting the
  // message reaches every frame in the tab and the ones that don't own it reply with a
  // spurious MEDIA_UNREGISTERED.
  sendToFrame(tabId, frameId, payload) {
    const options = typeof frameId === 'number' ? { frameId } : undefined;
    return browser.tabs.sendMessage(tabId, payload, options);
  }

  /**
   * Check if a URL/title combo should be ignored (Unknown source)
   */
  isUnknownMedia(url, title) {
    let hostname = 'Unknown';
    if (url) {
      try {
        hostname = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        hostname = 'Unknown';
      }
    }
    return (!hostname || hostname === 'Unknown') &&
           (!title || title === 'Unknown' || title === 'Unknown Media');
  }

  /**
   * Handle media registration
   */
  async handleMediaRegistered(tabId, frameId, data, tab) {
    const url = tab?.url || '';
    const title = data.title || tab?.title || 'Unknown';

    if (this.isUnknownMedia(url, title)) {
      Logger.debug('Unknown media registration ignored');
      return;
    }

    if (window.storageManager.isBlacklisted(url)) {
      Logger.debug('Blacklisted media registration ignored:', url);
      return;
    }

    const key = this.getMediaKey(tabId, frameId, data.mediaId);

    this.allMedia.set(key, {
      tabId,
      frameId,
      mediaId: data.mediaId,
      adapter: data.adapter || 'generic',
      url,
      title: data.title || tab?.title || 'Unknown',
      favicon: tab?.favIconUrl || '',
      cover: data.cover || '',
      duration: data.duration || 0,
      currentTime: data.currentTime || 0,
      isPlaying: data.isPlaying || false,
      hasSkip: data.hasSkip || false,
      mediaType: data.mediaType || 'unknown'
    });

    Logger.media('Registered', { mediaId: data.mediaId, title: data.title });
    this.broadcastUpdate();
  }

  /**
   * Handle media unregistration
   */
  async handleMediaUnregistered(tabId, frameId, data) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);

    Logger.media('Unregistered', data);

    this.allMedia.delete(key);
    this.recentPlayEvents.delete(data.mediaId);

    // CRITICAL: Cancel any pending resume/fade-in for this mediaId
    if (this.pendingResume && this.pendingResume.media?.mediaId === data.mediaId) {
      Logger.info('Cancelling pending resume - media was unregistered:', data.mediaId);
      this.cancelPendingResume(false);
    }

    // Remove from paused stack
    const prevStackLength = this.pausedStack.length;
    this.pausedStack = this.pausedStack.filter(m =>
      !(m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId)
    );
    if (this.pausedStack.length !== prevStackLength) {
      Logger.debug('Removed from paused stack');
    }

    // If this was the active media, clear and resume previous
    if (this.activeMedia &&
        this.activeMedia.tabId === tabId &&
        this.activeMedia.frameId === frameId &&
        this.activeMedia.mediaId === data.mediaId) {
      Logger.info('Active media unregistered, resuming previous');
      const stoppedMedia = { ...this.activeMedia };
      this.activeMedia = null;
      await this.scheduleResumePrevious(null, stoppedMedia);
    }

    this.broadcastUpdate();
  }

  /**
   * Handle media play event
   */
  async handleMediaPlay(tabId, frameId, data, tab) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);
    const url = tab?.url || '';
    const title = data.title || tab?.title || 'Unknown';

    if (this.isUnknownMedia(url, title)) {
      Logger.debug('Unknown media play event ignored');
      return;
    }

    // Ignore media in a tab the user muted at the browser level (tab speaker icon).
    // The element isn't muted, but the tab makes no sound, so it must not hold the audio
    // slot. Query the tab live — sender.tab.mutedInfo is often stale or absent.
    let tabMuted = tab?.mutedInfo?.muted === true;
    try {
      const liveTab = await browser.tabs.get(tabId);
      tabMuted = liveTab?.mutedInfo?.muted === true;
    } catch (e) {}
    if (tabMuted) {
      Logger.info('IGNORE play — tab is muted:', data.title || url);
      return;
    }

    // Check if this is just a heartbeat from already-active media FIRST
    const isSameMedia = this.activeMedia &&
                        this.activeMedia.tabId === tabId &&
                        this.activeMedia.frameId === frameId &&
                        this.activeMedia.mediaId === data.mediaId;

    if (isSameMedia) {
      this.activeMedia.lastHeartbeat = Date.now();
      this.activeMedia.title = data.title || this.activeMedia.title;
      this.activeMedia.cover = data.cover || this.activeMedia.cover;
      this.activeMedia.duration = data.duration || this.activeMedia.duration;
      this.activeMedia.currentTime = data.currentTime || this.activeMedia.currentTime;
      Logger.debug('Heartbeat from active media:', this.activeMedia.title);
      return;
    }

    // Rate limiting: prevent rapid-fire play events PER MEDIA (not global)
    // This allows legitimate new videos to play while preventing spam from same video
    const now = Date.now();
    const lastPlayTime = this.recentPlayEvents.get(data.mediaId);
    if (lastPlayTime && (now - lastPlayTime < MEDIA_MANAGER_CONFIG.RAPID_PLAY_COOLDOWN)) {
      Logger.info('IGNORE play — rapid cooldown:', data.title, `(${now - lastPlayTime}ms since last, need ${MEDIA_MANAGER_CONFIG.RAPID_PLAY_COOLDOWN}ms)`);
      return;
    }

    // Check if this media was recently paused by the extension (within last 500ms - reduced for TikTok)
    // This prevents "ghost" play events from re-activating paused media
    const recentlyPaused = this.pausedStack.find(m =>
      m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId &&
      !m.manuallyPaused && m.pausedAt && (Date.now() - m.pausedAt < 500)
    );

    if (recentlyPaused) {
      Logger.info('IGNORE play — media was auto-paused <500ms ago (ghost event):', data.title);
      return;
    }

    Logger.media('Play event', { title: data.title, url });

    // Track this play event (per-media, not global)
    this.recentPlayEvents.set(data.mediaId, now);

    // Clean up old entries from recentPlayEvents (older than 3 seconds)
    for (const [mediaId, timestamp] of this.recentPlayEvents.entries()) {
      if (now - timestamp > 3000) {
        this.recentPlayEvents.delete(mediaId);
      }
    }

    // Cancel any pending resume - new media is playing!
    this.cancelPendingResume();

    if (window.storageManager.isBlacklisted(url)) {
      Logger.info('IGNORE play — blacklisted site:', url);
      return;
    }

    // Update media info in allMedia
    if (this.allMedia.has(key)) {
      const media = this.allMedia.get(key);
      Object.assign(media, {
        isPlaying: true,
        title: data.title || media.title,
        cover: data.cover || media.cover,
        currentTime: data.currentTime || 0,
        duration: data.duration || media.duration
      });
    }

    // Notify desktop service that browser media is playing
    if (this.desktopConnector) {
      this.desktopConnector.notifyBrowserMediaPlay({
        mediaId: data.mediaId,
        title: data.title || tab?.title || 'Unknown',
        url
      });
    }

    // If there's already active media and it's not this one, pause it
    // BUT: Don't pause if this is rapid scrolling on the same tab (TikTok case)
    if (this.activeMedia) {
      const isSameTab = this.activeMedia.tabId === tabId;
      const timeSinceActiveStart = this.activeMedia.startedAt ? (now - this.activeMedia.startedAt) : Infinity;
      const isRapidScroll = isSameTab && timeSinceActiveStart < MEDIA_MANAGER_CONFIG.SCROLL_COOLDOWN;

      if (isRapidScroll) {
        // This is rapid scrolling on TikTok - don't pause, just switch active media
        Logger.info(`SWITCH without stacking — same-tab rapid (${Math.round(timeSinceActiveStart)}ms):`, this.activeMedia.title, '→', data.title);

        // Just remove old media from paused stack if it's there
        this.pausedStack = this.pausedStack.filter(m =>
          !(m.tabId === this.activeMedia.tabId &&
            m.frameId === this.activeMedia.frameId &&
            m.mediaId === this.activeMedia.mediaId)
        );
      } else {
        // Normal case: pause previous media
        Logger.info('New media started, pausing previous:', this.activeMedia.title);

        // Pause the previously active media (browser or desktop)
        await this.pauseActiveMedia();

        let manuallyPaused = false;
        if (this.isDesktopMedia(this.activeMedia) && this.desktopConnector) {
          const ds = this.desktopConnector.getState();
          const inPaused = ds.pausedList?.find(m => m.mediaId === this.activeMedia.mediaId);
          if (inPaused && inPaused.manuallyPaused) manuallyPaused = true;
        }

        this.pausedStack = this.pausedStack.filter(m =>
          !(m.tabId === this.activeMedia.tabId &&
            m.frameId === this.activeMedia.frameId &&
            m.mediaId === this.activeMedia.mediaId)
        );
        this.pausedStack.unshift({
          ...this.activeMedia,
          manuallyPaused,
          expired: false,
          pausedAt: Date.now()
        });

        Logger.success('Added to paused stack (by extension):', this.activeMedia.title);
      }
    }

    // Remove from paused stack if it was there (it's now playing)
    // Only remove the exact media that's playing, not all media from the same tab/frame
    // This prevents removing valid paused media when scrolling creates new media
    const prevStackLength = this.pausedStack.length;
    this.pausedStack = this.pausedStack.filter(m => {
      // Remove exact match only
      if (m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId) {
        return false;
      }
      // Don't remove other media from same tab/frame - they might be valid paused media
      // TikTok creates many videos, but we should preserve the paused stack
      return true;
    });

    if (prevStackLength !== this.pausedStack.length) {
      Logger.debug('Removed', prevStackLength - this.pausedStack.length, 'entry from paused stack');
    }

    // This is NEW media becoming active
    this.activeMedia = {
      tabId,
      frameId,
      mediaId: data.mediaId,
      adapter: data.adapter || 'generic',
      url,
      title: data.title || tab?.title || 'Unknown',
      favicon: tab?.favIconUrl || '',
      cover: data.cover || '',
      duration: data.duration || 0,
      currentTime: data.currentTime || 0,
      startedAt: Date.now(),
      lastHeartbeat: Date.now()
    };

    Logger.success('Now playing:', this.activeMedia.title);
    this.broadcastUpdate();
  }

  /**
   * Handle media pause event
   */
  async handleMediaPause(tabId, frameId, data) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);

    Logger.media('Pause event', { mediaId: data.mediaId, manual: data.manual });

    // Update media info
    if (this.allMedia.has(key)) {
      const media = this.allMedia.get(key);
      media.isPlaying = false;
      media.currentTime = data.currentTime || media.currentTime;
    }

    // If this was the active media
    if (this.activeMedia &&
        this.activeMedia.tabId === tabId &&
        this.activeMedia.frameId === frameId &&
        this.activeMedia.mediaId === data.mediaId) {

      const pausedMedia = {
        ...this.activeMedia,
        currentTime: data.currentTime || this.activeMedia.currentTime,
        manuallyPaused: !!data.manual
      };

      Logger.info(data.manual ? 'Manual pause detected' : 'Extension pause detected', '- adding to paused stack:', this.activeMedia.title);

      const stoppedMedia = { ...this.activeMedia };

      // Add to paused stack
      this.pausedStack = this.pausedStack.filter(m =>
        !(m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId)
      );
      this.pausedStack.unshift(pausedMedia);

      this.activeMedia = null;

      // Schedule resume of previous media
      await this.scheduleResumePrevious(null, stoppedMedia, data.manual);
    } else {
      // Media was paused but it wasn't the active one
      if (this.allMedia.has(key)) {
        const mediaInfo = this.allMedia.get(key);
        const existingIndex = this.pausedStack.findIndex(m =>
          m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId
        );

        if (existingIndex === -1) {
          Logger.info('Non-active media paused, adding to stack:', mediaInfo.title);
          this.pausedStack.push({
            ...mediaInfo,
            currentTime: data.currentTime || mediaInfo.currentTime,
            manuallyPaused: !!data.manual
          });
        } else if (data.manual) {
          this.pausedStack[existingIndex].manuallyPaused = true;
        }
      }
    }

    this.broadcastUpdate();
  }

  /**
   * Handle time update from content script (also serves as heartbeat)
   */
  handleTimeUpdate(tabId, frameId, data) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);
    const now = Date.now();

    if (this.allMedia.has(key)) {
      const media = this.allMedia.get(key);
      media.currentTime = data.currentTime;
      media.duration = data.duration || media.duration;
      if (data.title) media.title = data.title;
      media.lastHeartbeat = now;
    }

    if (this.activeMedia &&
        this.activeMedia.tabId === tabId &&
        this.activeMedia.frameId === frameId &&
        this.activeMedia.mediaId === data.mediaId) {
      this.activeMedia.currentTime = data.currentTime;
      this.activeMedia.duration = data.duration || this.activeMedia.duration;
      this.activeMedia.playbackRate = data.playbackRate || 1;
      if (data.title) this.activeMedia.title = data.title;
      this.activeMedia.lastHeartbeat = now;
      this.broadcastUpdate();
    }
  }

  /**
   * Handle media ended event
   */
  async handleMediaEnded(tabId, frameId, data) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);

    Logger.media('Ended', data);

    if (this.allMedia.has(key)) {
      this.allMedia.get(key).isPlaying = false;
    }

    if (this.activeMedia &&
        this.activeMedia.tabId === tabId &&
        this.activeMedia.frameId === frameId &&
        this.activeMedia.mediaId === data.mediaId) {
      Logger.info('Active media ended, scheduling resume of previous');
      const stoppedMedia = { ...this.activeMedia };
      this.activeMedia = null;
      await this.scheduleResumePrevious(null, stoppedMedia);
    }

    this.broadcastUpdate();
  }

  /**
   * Cancel any pending resume operation
   */
  cancelPendingResume(putBackInStack = true) {
    if (!this.pendingResume) return;

    Logger.debug('Cancelling pending resume, putBackInStack:', putBackInStack);
    clearTimeout(this.pendingResume.timeoutId);

    const media = this.pendingResume.media;
    if (putBackInStack && media) {
      const alreadyInStack = this.pausedStack.some(m =>
        m.tabId === media.tabId && m.frameId === media.frameId && m.mediaId === media.mediaId
      );
      if (!alreadyInStack) {
        Logger.info('Putting cancelled media back in paused stack:', media.title);
        this.pausedStack.unshift(media);
      }
    }
    this.pendingResume = null;
  }

  /**
   * Find the next media eligible for auto-resume (not manually paused or expired)
   * @param {string} excludeMediaId - Optional mediaId to exclude (the one that just stopped)
   */
  findNextAutoResumable(excludeMediaId = null) {
    const index = this.pausedStack.findIndex(m =>
      !m.manuallyPaused && !m.expired && m.mediaId !== excludeMediaId
    );
    if (index !== -1) {
      const media = this.pausedStack[index];
      this.pausedStack.splice(index, 1);
      return media;
    }
    return null;
  }

  /**
   * Schedule resuming previous media with delay and fade-in
   */
  async scheduleResumePrevious(specificMedia = null, stoppedMedia = null, wasManualPause = false) {
    // Cancel any existing pending resume
    this.cancelPendingResume();

    const settings = window.storageManager.get();

    // Check auto-expire first
    if (stoppedMedia && settings.autoExpireSeconds > 0) {
      const playDuration = (Date.now() - (stoppedMedia.startedAt || Date.now())) / 1000;
      Logger.debug(`Auto-expire check: played ${Math.round(playDuration)}s, threshold ${settings.autoExpireSeconds}s`);

      if (playDuration >= settings.autoExpireSeconds) {
        Logger.info(`AUTO-EXPIRE: Media played for ${Math.round(playDuration)}s - expiring ALL paused media`);

        // Mark ALL paused media as expired (separate from manuallyPaused)
        // This ensures old media won't be auto-resumed later when new media stops
        // They can still be manually resumed by clicking play
        this.pausedStack.forEach(m => {
          m.expired = true;
        });

        this.broadcastUpdate();
        return;
      }
    }

    // Check resumeOnManualPause setting
    if (wasManualPause && !settings.resumeOnManualPause) {
      Logger.info('Manual pause with resumeOnManualPause=false - not auto-resuming');
      this.broadcastUpdate();
      return;
    }

    // Get media to resume (exclude the one that just stopped to avoid resuming itself)
    let toResume = specificMedia;
    if (!toResume) {
      toResume = this.findNextAutoResumable(stoppedMedia?.mediaId);
    }

    if (!toResume) {
      Logger.debug('No eligible media to auto-resume');
      this.broadcastUpdate();
      return;
    }

    Logger.info(`Scheduling resume of "${toResume.title}" in ${settings.resumeDelay}ms`);

    const timeoutId = setTimeout(async () => {
      Logger.success('Resume delay elapsed, starting playback');
      await this.playMediaWithFadeIn(toResume);
    }, settings.resumeDelay);

    this.pendingResume = { timeoutId, media: toResume };

    this.broadcastUpdate();
  }

  /**
   * Resume media. Volume fade-in happens locally in the content script (one command,
   * no IPC volume storm), so here we just send the play command with the fade params.
   */
  async playMediaWithFadeIn(media) {
    const settings = window.storageManager.get();
    this.pendingResume = null;

    if (this.isDesktopMedia(media)) {
      Logger.success('RESUME desktop media:', media.title);
      if (this.desktopConnector) {
        this.desktopConnector.controlDesktopMedia('play', media.mediaId);
      }
      this.activeMedia = { ...media, startedAt: Date.now(), lastHeartbeat: Date.now() };
      this.broadcastUpdate();
      return;
    }

    const { tabId, frameId, mediaId } = media;
    const fade = settings.fadeInDuration > 0
      ? { duration: settings.fadeInDuration, startVolume: settings.fadeInStartVolume }
      : null;

    // Mark active BEFORE sending. This way (a) the popup updates instantly, (b) media that
    // starts during the IPC round-trip correctly supersedes this resume, and (c) the
    // content script suppresses its own play echo (suppressEcho) so it can't steal back.
    const optimistic = { ...media, startedAt: Date.now(), lastHeartbeat: Date.now() };
    this.activeMedia = optimistic;
    Logger.success(`RESUME "${optimistic.title}"` + (fade
      ? ` — fade-in ${fade.duration}ms from ${Math.round(fade.startVolume * 100)}%`
      : ' — no fade'));
    this.broadcastUpdate();

    try {
      await this.sendToFrame(tabId, frameId, {
        type: AUTOSTOP.MSG.CONTROL,
        action: AUTOSTOP.ACTION.PLAY,
        mediaId,
        frameId,
        fade,
        suppressEcho: true
      });
    } catch (e) {
      Logger.error('Resume failed, media unreachable:', e.message);
      // If something else became active during the round-trip, don't clobber it.
      if (this.activeMedia !== optimistic) {
        this.broadcastUpdate();
        return;
      }
      this.activeMedia = null;
      const next = this.findNextAutoResumable();
      if (next) return this.playMediaWithFadeIn(next);
      this.broadcastUpdate();
    }
  }

  /**
   * Send pause command to browser media
   */
  async pauseMedia(tabId, frameId, mediaId) {
    const key = this.getMediaKey(tabId, frameId, mediaId);
    if (this.allMedia.has(key)) {
      this.allMedia.get(key).isPlaying = false;
    }

    try {
      await this.sendToFrame(tabId, frameId, {
        type: AUTOSTOP.MSG.CONTROL,
        action: AUTOSTOP.ACTION.PAUSE,
        mediaId,
        frameId
      });
    } catch (e) {
      Logger.error('Failed to pause media:', e.message);
    }
  }

  /**
   * Pause the currently active media (browser or desktop)
   */
  async pauseActiveMedia() {
    if (!this.activeMedia) return;

    if (this.isDesktopMedia(this.activeMedia)) {
      if (this.desktopConnector) {
        this.desktopConnector.controlDesktopMedia('pause', this.activeMedia.mediaId);
      }
    } else {
      await this.pauseMedia(
        this.activeMedia.tabId,
        this.activeMedia.frameId,
        this.activeMedia.mediaId
      );
    }
  }

  /**
   * Handle control command from popup
   */
  async controlMedia(data) {
    const { tabId, frameId, mediaId, action } = data;

    Logger.info('Popup control:', action, mediaId);

    // Check if this is desktop media
    if (mediaId && mediaId.startsWith('desktop-')) {
      await this.controlDesktopMedia(mediaId, action);
      return;
    }

    try {
      if (action === AUTOSTOP.ACTION.PLAY) {
        this.cancelPendingResume();

        const stackIndex = this.pausedStack.findIndex(m =>
          m.tabId === tabId && m.frameId === frameId && m.mediaId === mediaId
        );
        if (stackIndex !== -1) {
          this.pausedStack.splice(stackIndex, 1);
        }

        await this.sendToFrame(tabId, frameId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PLAY,
          mediaId,
          frameId
        });

      } else if (action === AUTOSTOP.ACTION.PAUSE) {
        let stoppedMedia = null;

        if (this.activeMedia &&
            this.activeMedia.tabId === tabId &&
            this.activeMedia.frameId === frameId &&
            this.activeMedia.mediaId === mediaId) {

          stoppedMedia = { ...this.activeMedia };

          this.pausedStack = this.pausedStack.filter(m =>
            !(m.tabId === tabId && m.frameId === frameId && m.mediaId === mediaId)
          );
          this.pausedStack.unshift({
            ...this.activeMedia,
            manuallyPaused: true
          });
          this.activeMedia = null;
        }

        await this.sendToFrame(tabId, frameId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PAUSE,
          mediaId,
          frameId
        });

        await this.scheduleResumePrevious(null, stoppedMedia, true);

      } else if (action === AUTOSTOP.ACTION.SKIP) {
        await this.sendToFrame(tabId, frameId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.SKIP,
          mediaId,
          frameId
        });

      } else if (action === AUTOSTOP.ACTION.PREV) {
        await this.sendToFrame(tabId, frameId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PREV,
          mediaId,
          frameId
        });
      }
    } catch (e) {
      Logger.error('Failed to control media:', e.message);
    }

    this.broadcastUpdate();
  }

  /**
   * Handle control command for desktop media
   */
  async controlDesktopMedia(mediaId, action) {
    if (!this.desktopConnector) {
      Logger.warn('Desktop connector not available');
      return;
    }

    Logger.info('Desktop control:', action, mediaId);

    if (action === AUTOSTOP.ACTION.PLAY) {
      this.cancelPendingResume();

      const stackIndex = this.pausedStack.findIndex(m => m.mediaId === mediaId);
      if (stackIndex !== -1) {
        this.pausedStack.splice(stackIndex, 1);
      }

      this.desktopConnector.controlDesktopMedia('play', mediaId);

    } else if (action === AUTOSTOP.ACTION.PAUSE) {
      let stoppedMedia = null;

      if (this.activeMedia && this.activeMedia.mediaId === mediaId) {
        stoppedMedia = { ...this.activeMedia };

        this.pausedStack = this.pausedStack.filter(m => m.mediaId !== mediaId);
        this.pausedStack.unshift({
          ...this.activeMedia,
          manuallyPaused: true
        });
        this.activeMedia = null;
      }

      this.desktopConnector.controlDesktopMedia('pause', mediaId);
      await this.scheduleResumePrevious(null, stoppedMedia, true);

    } else if (action === AUTOSTOP.ACTION.SKIP) {
      this.desktopConnector.controlDesktopMedia('skip', mediaId);

    } else if (action === AUTOSTOP.ACTION.PREV) {
      this.desktopConnector.controlDesktopMedia('prev', mediaId);
    }

    this.broadcastUpdate();
  }

  /**
   * Handle tab closed
   */
  async handleTabClosed(tabId) {
    Logger.info('Tab closed:', tabId);

    const stoppedMedia = (this.activeMedia && this.activeMedia.tabId === tabId)
      ? { ...this.activeMedia }
      : null;

    // Remove all media from this tab
    for (const [key, media] of this.allMedia.entries()) {
      if (media.tabId === tabId) {
        this.allMedia.delete(key);
      }
    }

    // Remove from paused stack (only non-desktop with this tabId)
    const prevLength = this.pausedStack.length;
    this.pausedStack = this.pausedStack.filter(m => m.tabId !== tabId || this.isDesktopMedia(m));

    // Cancel pending resume if it was for this tab
    if (this.pendingResume?.media?.tabId === tabId) {
      this.cancelPendingResume(false);
    }

    if (stoppedMedia) {
      Logger.info('Active media tab closed:', stoppedMedia.title);
      this.activeMedia = null;
      await this.scheduleResumePrevious(null, stoppedMedia);
    }

    this.broadcastUpdate();
  }

  /**
   * Update favicon for a tab
   */
  updateTabFavicon(tabId, favicon) {
    for (const media of this.allMedia.values()) {
      if (media.tabId === tabId) {
        media.favicon = favicon;
      }
    }
    if (this.activeMedia && this.activeMedia.tabId === tabId) {
      this.activeMedia.favicon = favicon;
    }
    this.broadcastUpdate();
  }

  /**
   * A tab's browser-level mute state changed. A muted tab makes no sound, so if the
   * active media lives in it, treat it as stopped and resume whatever was paused.
   */
  async handleTabMutedChange(tabId, muted) {
    if (muted) {
      if (this.activeMedia && !this.isDesktopMedia(this.activeMedia) && this.activeMedia.tabId === tabId) {
        Logger.info('Active tab muted — treating as stopped, resuming previous:', this.activeMedia.title);
        const stoppedMedia = { ...this.activeMedia };
        this.activeMedia = null;
        await this.scheduleResumePrevious(null, stoppedMedia);
      }
    } else {
      // Unmuted: ask the tab to re-announce its playing media so it can reclaim the slot
      // (it was only browser-silenced, never actually paused, so it won't self-report).
      try { await browser.tabs.sendMessage(tabId, { type: 'PING' }); } catch (e) {}
    }
  }

  /**
   * Get current state
   */
  getState() {
    const desktopState = this.desktopConnector?.getState() || { connected: false, activeMedia: null, pausedList: [] };

    // Combine paused lists and deduplicate
    const combinedPausedStack = [...this.pausedStack];

    // Add desktop paused items if not already in stack
    if (desktopState.pausedList) {
      for (const m of desktopState.pausedList) {
        const exists = combinedPausedStack.some(p => p.mediaId === m.mediaId);
        if (!exists) {
          combinedPausedStack.push({ ...m, manuallyPaused: m.manuallyPaused || false });
        }
      }
    }

    return {
      activeMedia: this.activeMedia,
      pausedStack: combinedPausedStack,
      allMedia: Array.from(this.allMedia.values()),
      settings: window.storageManager.get(),
      pendingResume: this.pendingResume ? { media: this.pendingResume.media } : null,
      desktopConnected: desktopState.connected
    };
  }

  // ============================================================================
  // DESKTOP MEDIA EVENT HANDLERS
  // ============================================================================

  /**
   * Called when desktop connector connects
   */
  onDesktopConnected() {
    Logger.success('Desktop service connected');
    this.broadcastUpdate();
  }

  /**
   * Called when desktop connector disconnects
   */
  onDesktopDisconnected() {
    Logger.info('Desktop service disconnected');

    if (this.isDesktopMedia(this.activeMedia)) {
      this.activeMedia = null;
    }

    this.pausedStack = this.pausedStack.filter(m => !this.isDesktopMedia(m));
    this.broadcastUpdate();
  }

  /**
   * Called when desktop media starts playing
   */
  async onDesktopMediaPlay(desktopMedia) {
    Logger.media('Desktop play', desktopMedia);

    // Cancel any pending resume, returning that media to the paused stack so it can still
    // auto-resume later when the desktop media stops.
    this.cancelPendingResume(true);

    // Pause the previously-active media (browser or desktop) if it's a different one.
    if (this.activeMedia && !this.isSameMedia(this.activeMedia, desktopMedia)) {
      Logger.info('Desktop media took over, pausing active:', this.activeMedia.title);
      const previousMedia = { ...this.activeMedia };
      await this.pauseActiveMedia();
      this.pausedStack = this.pausedStack.filter(m => !this.isSameMedia(m, previousMedia));
      this.pausedStack.unshift({ ...previousMedia, manuallyPaused: false, expired: false, pausedAt: Date.now() });
    }

    // Robustness: pause ANY browser media still audibly playing, not just the tracked
    // active pointer. The pointer can be stale/null (e.g. a playlist advanced tracks) while
    // a tab keeps playing — that's why desktop media sometimes failed to silence the browser.
    for (const media of this.allMedia.values()) {
      if (this.isDesktopMedia(media) || !media.isPlaying) continue;
      if (this.isSameMedia(media, this.activeMedia)) continue;
      Logger.info('Desktop took over — also pausing playing browser media:', media.title);
      await this.pauseMedia(media.tabId, media.frameId, media.mediaId);
      media.isPlaying = false;
      this.pausedStack = this.pausedStack.filter(m => !this.isSameMedia(m, media));
      this.pausedStack.unshift({ ...media, manuallyPaused: false, expired: false, pausedAt: Date.now() });
    }

    // Remove desktop from paused stack
    this.pausedStack = this.pausedStack.filter(m => !this.isSameMedia(m, desktopMedia));

    // Set desktop as active
    this.activeMedia = {
      ...desktopMedia,
      startedAt: Date.now(),
      lastHeartbeat: Date.now()
    };

    Logger.success('Now playing (desktop):', this.activeMedia.title);
    this.broadcastUpdate();
  }

  /**
   * Called when desktop media pauses
   */
  async onDesktopMediaPause(desktopMedia) {
    Logger.media('Desktop pause', desktopMedia);

    if (this.activeMedia && this.activeMedia.mediaId === desktopMedia.mediaId) {
      this.pausedStack = this.pausedStack.filter(m => m.mediaId !== desktopMedia.mediaId);
      this.pausedStack.unshift({
        ...desktopMedia,
        manuallyPaused: desktopMedia.manuallyPaused || false
      });

      const stoppedMedia = { ...this.activeMedia };
      this.activeMedia = null;

      // Schedule resume of previous media
      await this.scheduleResumePrevious(null, stoppedMedia, desktopMedia.manuallyPaused);
    } else if (desktopMedia.manuallyPaused) {
      const idx = this.pausedStack.findIndex(m => m.mediaId === desktopMedia.mediaId);
      if (idx !== -1 && !this.pausedStack[idx].manuallyPaused) {
        this.pausedStack[idx].manuallyPaused = true;
      }
    }

    this.broadcastUpdate();
  }

  /**
   * Broadcast state update to popup
   */
  broadcastUpdate() {
    this.updateIcon();

    if (this.desktopConnector && this.desktopConnector.connected) {
      this.desktopConnector.sendBrowserState();
    }

    browser.runtime.sendMessage({
      type: AUTOSTOP.MSG.STATE_UPDATE,
      data: this.getState()
    }).catch(() => {});
  }

  /**
   * Update browser action icon based on media state
   */
  updateIcon() {
    const hasActiveMedia = this.activeMedia !== null;

    const icon = hasActiveMedia ? 'icons/icon-active.svg' : 'icons/icon-idle.svg';
    const title = hasActiveMedia
      ? `Auto-Stop Media - Playing: ${this.activeMedia.title || 'Unknown'}`
      : 'Auto-Stop Media - No media playing';

    browser.browserAction.setIcon({ path: icon }).catch(() => {});
    browser.browserAction.setTitle({ title }).catch(() => {});
  }
}

// Make available globally
window.mediaManager = new MediaManager();
