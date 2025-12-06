// Auto-Stop Media - Media Manager
// Manages media state across all tabs and desktop apps

class MediaManager {
  constructor() {
    // Currently active media (browser OR desktop)
    this.activeMedia = null; // { tabId, frameId, mediaId, url, title, favicon, startedAt, lastHeartbeat, isDesktop?, ... }

    // Stack of paused media (most recent first)
    // Each item has: { ...mediaInfo, manuallyPaused: boolean }
    // manuallyPaused = true means user paused it, won't auto-resume
    // manuallyPaused = false means extension paused it, can auto-resume
    this.pausedStack = [];

    // All known media elements (browser only)
    this.allMedia = new Map(); // key: `${tabId}-${frameId}-${mediaId}`

    // Resume state management
    this.pendingResume = null;      // { timeoutId, media, fadeInterval }
    this.originalVolumes = new Map(); // mediaId -> original volume (0-1)

    // Desktop connector (initialized in index.js)
    this.desktopConnector = null;

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
   * If we don't hear from active media for too long, consider it gone
   */
  startStaleCheck() {
    setInterval(() => {
      this.checkForStaleMedia();
    }, 3000); // Check every 3 seconds
  }

  /**
   * Check if active media is stale (no heartbeat for too long)
   */
  checkForStaleMedia() {
    if (!this.activeMedia) return;

    const now = Date.now();
    const lastHeartbeat = this.activeMedia.lastHeartbeat || this.activeMedia.startedAt || now;
    const staleDuration = now - lastHeartbeat;

    // If no heartbeat for 5 seconds, media might be gone
    if (staleDuration > 5000) {
      Logger.warn('Active media appears stale (no heartbeat for', Math.round(staleDuration / 1000), 'seconds)');

      // Try to ping the tab to see if media is still there
      this.pingActiveMedia();
    }
  }

  /**
   * Ping the active media's tab to verify it's still playing
   */
  async pingActiveMedia() {
    if (!this.activeMedia) return;

    // Don't ping desktop media - it's managed by the desktop connector
    if (this.isDesktopMedia(this.activeMedia)) {
      return;
    }

    const { tabId, frameId, mediaId } = this.activeMedia;

    try {
      // Try to send a message to the tab
      await browser.tabs.sendMessage(tabId, {
        type: 'PING',
        mediaId,
        frameId
      });
      // If we get here without error, the tab is still responsive
      // The content script should respond with a play event if media is still playing
    } catch (e) {
      // Tab might be closed or content script unloaded
      Logger.warn('Cannot reach active media tab, clearing active media');
      const stoppedMedia = { ...this.activeMedia };
      this.activeMedia = null;
      this.broadcastUpdate();
      // Try to resume previous media
      await this.scheduleResumePrevious(null, stoppedMedia);
    }
  }

  /**
   * Generate a unique key for media
   */
  getMediaKey(tabId, frameId, mediaId) {
    return `${tabId}-${frameId}-${mediaId}`;
  }

  /**
   * Check if a URL/title combo should be ignored (Unknown source)
   */
  isUnknownMedia(url, title) {
    // Get hostname from URL
    let hostname = 'Unknown';
    if (url) {
      try {
        hostname = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        hostname = 'Unknown';
      }
    }

    // Ignore if both hostname and title are Unknown
    const isUnknown = (!hostname || hostname === 'Unknown') &&
                      (!title || title === 'Unknown' || title === 'Unknown Media');

    return isUnknown;
  }

  /**
   * Handle media registration
   */
  async handleMediaRegistered(tabId, frameId, data, tab) {
    const url = tab?.url || '';
    const title = data.title || tab?.title || 'Unknown';

    // Ignore Unknown media completely
    if (this.isUnknownMedia(url, title)) {
      Logger.debug('Unknown media registration ignored');
      return;
    }

    // Don't register Blacklisted media
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
    this.originalVolumes.delete(data.mediaId);

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

    // Ignore Unknown media completely
    if (this.isUnknownMedia(url, title)) {
      Logger.debug('Unknown media play event ignored');
      return;
    }

    Logger.media('Play event', { title: data.title, url });

    // Cancel any pending resume - new media is playing!
    this.cancelPendingResume();

    // Check Blacklist - Blacklisted media is completely ignored
    if (window.storageManager.isBlacklisted(url)) {
      Logger.debug('Blacklisted media play ignored:', url);
      return;
    }

    // Check if this is already the active media (prevents repeated notifications)
    const isAlreadyActive = this.activeMedia &&
      this.activeMedia.tabId === tabId &&
      this.activeMedia.frameId === frameId &&
      this.activeMedia.mediaId === data.mediaId;

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
    // Only notify if this media is newly playing (not already active)
    if (this.desktopConnector && !isAlreadyActive) {
      this.desktopConnector.notifyBrowserMediaPlay({
        mediaId: data.mediaId,
        title: data.title || tab?.title || 'Unknown',
        url
      });
    }

    // If there's already active media and it's not this one
    if (this.activeMedia &&
        !(this.activeMedia.tabId === tabId &&
          this.activeMedia.frameId === frameId &&
          this.activeMedia.mediaId === data.mediaId)) {

      Logger.info('New media started, pausing previous:', this.activeMedia.title);

      // Pause the previously active media (browser or desktop)
      await this.pauseActiveMedia();

      // Add to paused stack with manuallyPaused = FALSE (extension paused it)
      // Remove if already there first
      this.pausedStack = this.pausedStack.filter(m =>
        !(m.tabId === this.activeMedia.tabId &&
          m.frameId === this.activeMedia.frameId &&
          m.mediaId === this.activeMedia.mediaId)
      );
      this.pausedStack.unshift({
        ...this.activeMedia,
        manuallyPaused: false  // Extension paused it, can auto-resume
      });

      Logger.success('Added to paused stack (by extension):', this.activeMedia.title);
      Logger.debug('Paused stack length:', this.pausedStack.length);
    }

    // Remove from paused stack if it was there (it's now playing)
    // Also clear its manuallyPaused flag since it's now active
    // IMPORTANT: Also remove OLD entries from the same tab that might be stale
    // (sites like YouTube recreate media elements with new IDs)
    const prevStackLength = this.pausedStack.length;
    this.pausedStack = this.pausedStack.filter(m => {
      // Always remove the exact match
      if (m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId) {
        return false;
      }
      // Also remove other entries from the same tab/frame that are likely stale
      // (if a tab has new media playing, old entries are probably invalid)
      if (m.tabId === tabId && m.frameId === frameId) {
        Logger.debug('Cleaning up stale paused entry from same tab:', m.title, m.mediaId);
        return false;
      }
      return true;
    });

    if (prevStackLength !== this.pausedStack.length) {
      Logger.debug('Cleaned up', prevStackLength - this.pausedStack.length, 'entries from paused stack');
    }

    // Check if this is already the active media (just a heartbeat/update)
    const isSameMedia = this.activeMedia &&
                        this.activeMedia.tabId === tabId &&
                        this.activeMedia.frameId === frameId &&
                        this.activeMedia.mediaId === data.mediaId;

    if (isSameMedia) {
      // Just update the heartbeat and metadata, keep startedAt intact
      this.activeMedia.lastHeartbeat = Date.now();
      this.activeMedia.title = data.title || this.activeMedia.title;
      this.activeMedia.cover = data.cover || this.activeMedia.cover;
      this.activeMedia.duration = data.duration || this.activeMedia.duration;
      this.activeMedia.currentTime = data.currentTime || this.activeMedia.currentTime;
      Logger.debug('Heartbeat from active media:', this.activeMedia.title);
      return; // Don't broadcast update for heartbeats
    }

    // This is NEW media becoming active - set startedAt
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
      startedAt: Date.now(), // Track when this NEW media started playing
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
        manuallyPaused: !!data.manual  // Track if user paused it manually
      };

      Logger.info(data.manual ? 'Manual pause detected' : 'Extension pause detected', '- adding to paused stack:', this.activeMedia.title);

      // Store the stopped media info for auto-expire check (before clearing activeMedia)
      const stoppedMedia = { ...this.activeMedia };

      // Add to paused stack (remove if already there first)
      this.pausedStack = this.pausedStack.filter(m =>
        !(m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId)
      );
      this.pausedStack.unshift(pausedMedia);

      // Deduplicate to prevent duplicates
      this._deduplicatePausedStack();

      // CRITICAL: Check if desktop is in paused stack BEFORE clearing activeMedia
      // This prevents browser from resuming when desktop is about to play
      const desktopInPaused = this.pausedStack.some(m => m.isDesktop);

      this.activeMedia = null;

      // Check again after clearing (desktop might have become active)
      // Also check paused stack for desktop media
      if (desktopInPaused) {
        Logger.info('Desktop media in paused list - NOT scheduling browser resume (desktop might start)');
        this.broadcastUpdate();
        return;
      }

      // CRITICAL: Add a delay before resuming to give desktop time to register
      // This prevents browser from resuming when desktop is starting to play
      // Desktop might not be in paused stack yet, but might be starting
      const resumeDelay = 1500; // 1.5 second delay to allow desktop state to update

      // Check desktop state before scheduling resume
      if (this.desktopConnector) {
        const desktopState = this.desktopConnector.getState();
        const desktopActive = desktopState.activeMedia;
        const desktopPlayInProgress = this.desktopConnector._desktopPlayInProgress;
        const desktopRecentlyActive = this.desktopConnector._desktopLastActiveTime;
        const timeSinceDesktopActive = desktopRecentlyActive ? (Date.now() - desktopRecentlyActive) : Infinity;

        // If desktop is active or about to be active, don't resume
        if (desktopActive || desktopPlayInProgress || timeSinceDesktopActive < 5000) {
          Logger.info('Desktop is active or starting - NOT scheduling browser resume');
          this.broadcastUpdate();
          return;
        }

        // Check if desktop media exists in paused list
        if (desktopState.pausedList && desktopState.pausedList.length > 0) {
          Logger.info('Desktop media in paused list (from connector) - NOT scheduling browser resume');
          this.broadcastUpdate();
          return;
        }
      }

      // Schedule resume with a delay to allow desktop state to update
      const resumeTimeoutId = setTimeout(async () => {
        // Double-check desktop state before actually resuming
        if (this.desktopConnector) {
          const desktopState = this.desktopConnector.getState();
          const desktopActive = desktopState.activeMedia;
          const desktopPlayInProgress = this.desktopConnector._desktopPlayInProgress;
          const desktopRecentlyActive = this.desktopConnector._desktopLastActiveTime;
          const timeSinceDesktopActive = desktopRecentlyActive ? (Date.now() - desktopRecentlyActive) : Infinity;

          if (desktopActive || desktopPlayInProgress || timeSinceDesktopActive < 3000) {
            Logger.info('Desktop became active during delay - NOT resuming browser');
            this.broadcastUpdate();
            return;
          }

          // Check paused list again
          if (desktopState.pausedList && desktopState.pausedList.length > 0) {
            Logger.info('Desktop media appeared in paused list during delay - NOT resuming browser');
            this.broadcastUpdate();
            return;
          }
        }

        // Final check in scheduleResumePrevious itself
        await this.scheduleResumePrevious(null, stoppedMedia, data.manual);
      }, resumeDelay);

      // Store timeout ID so we can cancel it if desktop starts
      this._pendingResumeTimeout = resumeTimeoutId;
    } else {
      // Media was paused but it wasn't the active one
      // Still add/update it in the paused stack if it exists in allMedia
      if (this.allMedia.has(key)) {
        const mediaInfo = this.allMedia.get(key);

        // Check if already in paused stack
        const existingIndex = this.pausedStack.findIndex(m =>
          m.tabId === tabId && m.frameId === frameId && m.mediaId === data.mediaId
        );

        if (existingIndex === -1) {
          // Not in stack, add it
          Logger.info('Non-active media paused, adding to stack:', mediaInfo.title);
          this.pausedStack.push({
            ...mediaInfo,
            currentTime: data.currentTime || mediaInfo.currentTime,
            manuallyPaused: !!data.manual
          });
        } else {
          // Already in stack, update its manuallyPaused flag if manually paused
          if (data.manual) {
            this.pausedStack[existingIndex].manuallyPaused = true;
            Logger.debug('Updated existing paused media to manually paused');
          }
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

    // Update in allMedia
    if (this.allMedia.has(key)) {
      const media = this.allMedia.get(key);
      media.currentTime = data.currentTime;
      media.duration = data.duration || media.duration;
      media.lastHeartbeat = now;
    }

    // Update active media if this is it
    if (this.activeMedia &&
        this.activeMedia.tabId === tabId &&
        this.activeMedia.frameId === frameId &&
        this.activeMedia.mediaId === data.mediaId) {
      this.activeMedia.currentTime = data.currentTime;
      this.activeMedia.duration = data.duration || this.activeMedia.duration;
      this.activeMedia.playbackRate = data.playbackRate || 1;
      this.activeMedia.lastHeartbeat = now; // Update heartbeat timestamp

      this.broadcastUpdate();
    }
  }

  /**
   * Handle media ended event
   */
  async handleMediaEnded(tabId, frameId, data) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);

    Logger.media('Ended', data);

    // Update media info
    if (this.allMedia.has(key)) {
      this.allMedia.get(key).isPlaying = false;
    }

    // If this was the active media, resume previous
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
   * @param {boolean} putBackInStack - If true, put the pending media back in the paused stack
   */
  cancelPendingResume(putBackInStack = true) {
    if (this.pendingResume) {
      Logger.debug('Cancelling pending resume, putBackInStack:', putBackInStack);
      clearTimeout(this.pendingResume.timeoutId);
      if (this.pendingResume.fadeInterval) {
        clearInterval(this.pendingResume.fadeInterval);
      }
      // Reset volume if we were fading in
      if (this.pendingResume.media) {
        this.resetVolume(this.pendingResume.media);

        // Put the media back in the paused stack so it's not lost
        if (putBackInStack) {
          // Check if it's not already in the stack
          const alreadyInStack = this.pausedStack.some(m =>
            m.tabId === this.pendingResume.media.tabId &&
            m.frameId === this.pendingResume.media.frameId &&
            m.mediaId === this.pendingResume.media.mediaId
          );
          if (!alreadyInStack) {
            Logger.info('Putting cancelled media back in paused stack:', this.pendingResume.media.title);
            this.pausedStack.unshift(this.pendingResume.media);
          }
        }
      }
      this.pendingResume = null;
    }
  }

  /**
   * Find the next media eligible for auto-resume (not manually paused)
   */
  findNextAutoResumable() {
    // Find first item that was NOT manually paused
    const index = this.pausedStack.findIndex(m => !m.manuallyPaused);
    if (index !== -1) {
      const media = this.pausedStack[index];
      this.pausedStack.splice(index, 1);
      return media;
    }
    return null;
  }

  /**
   * Schedule resuming previous media with delay and fade-in
   * @param {Object|null} specificMedia - Specific media to resume (bypasses stack)
   * @param {Object|null} stoppedMedia - The media that just stopped (for auto-expire check)
   * @param {boolean} wasManualPause - Whether the stop was caused by user action (not extension)
   */
  async scheduleResumePrevious(specificMedia = null, stoppedMedia = null, wasManualPause = false) {
    // Cancel any existing pending resume
    this.cancelPendingResume();

    // CRITICAL: Check desktop connector state FIRST - this is the most up-to-date
    // Check if desktop media is active or if desktop play is in progress
    if (this.desktopConnector) {
      const desktopState = this.desktopConnector.getState();
      const desktopActive = desktopState.activeMedia;
      const desktopPlayInProgress = this.desktopConnector._desktopPlayInProgress;
      const desktopRecentlyActive = this.desktopConnector._desktopLastActiveTime;
      const timeSinceDesktopActive = desktopRecentlyActive ? (Date.now() - desktopRecentlyActive) : Infinity;

      // If desktop is active, don't resume browser
      if (desktopActive) {
        Logger.info('Desktop media is active (from connector) - NOT resuming browser media');
        this.broadcastUpdate();
        return;
      }

      // If desktop play is in progress (flag set), don't resume browser
      if (desktopPlayInProgress) {
        Logger.info('Desktop play in progress (flag set) - NOT resuming browser media');
        this.broadcastUpdate();
        return;
      }

      // If desktop was active within last 5 seconds, don't resume (might be transitioning)
      if (timeSinceDesktopActive < 5000) {
        Logger.info(`Desktop was active ${Math.round(timeSinceDesktopActive/1000)}s ago - NOT resuming browser (might be transitioning)`);
        this.broadcastUpdate();
        return;
      }

      // Check if desktop media exists in paused list (might be starting soon)
      if (desktopState.pausedList && desktopState.pausedList.length > 0) {
        Logger.info('Desktop media in paused list (from connector) - NOT resuming browser (desktop might start)');
        this.broadcastUpdate();
        return;
      }
    }

    // CRITICAL: If desktop media is currently active, DO NOT resume browser media
    // This prevents browser from resuming when desktop starts playing
    if (this.activeMedia && this.activeMedia.isDesktop) {
      Logger.info('Desktop media is active - NOT resuming browser media');
      this.broadcastUpdate();
      return;
    }

    // Also check if desktop media is in paused list (might be starting soon)
    // Don't resume browser if desktop is about to play
    const desktopInPaused = this.pausedStack.some(m => m.isDesktop);
    if (desktopInPaused) {
      Logger.info('Desktop media in paused list - NOT resuming browser (desktop might start)');
      this.broadcastUpdate();
      return;
    }

    const settings = window.storageManager.get();

    // PRIORITY 1: Check auto-expire FIRST (takes precedence over all other settings)
    // If the stopped media played for longer than autoExpireSeconds, don't resume anything
    if (stoppedMedia && settings.autoExpireSeconds > 0) {
      const playDuration = (Date.now() - (stoppedMedia.startedAt || Date.now())) / 1000;
      Logger.debug(`Auto-expire check: played ${Math.round(playDuration)}s, threshold ${settings.autoExpireSeconds}s`);

      if (playDuration >= settings.autoExpireSeconds) {
        Logger.info(`AUTO-EXPIRE TRIGGERED: Media played for ${Math.round(playDuration)}s (>= ${settings.autoExpireSeconds}s) - NOT resuming old media`);
        this.broadcastUpdate();
        return; // Don't resume anything
      }
    }

    // PRIORITY 2: Check resumeOnManualPause setting
    // Only applies if media played LESS than autoExpireSeconds
    if (wasManualPause && !settings.resumeOnManualPause) {
      Logger.info('Manual pause with resumeOnManualPause=false - not auto-resuming');
      this.broadcastUpdate();
      return;
    }

    // Get media to resume
    let toResume = specificMedia;
    if (!toResume) {
      // Find next auto-resumable (not manually paused)
      toResume = this.findNextAutoResumable();
    }

    if (!toResume) {
      Logger.debug('No eligible media to auto-resume (all are manually paused or stack is empty)');
      this.broadcastUpdate();
      return;
    }

    Logger.info(`Scheduling resume of "${toResume.title}" in ${settings.resumeDelay}ms`);

    // Schedule the resume with delay
    const timeoutId = setTimeout(async () => {
      Logger.success('Resume delay elapsed, starting playback with fade-in');
      await this.playMediaWithFadeIn(toResume);
    }, settings.resumeDelay);

    this.pendingResume = {
      timeoutId,
      media: toResume,
      fadeInterval: null
    };

    this.broadcastUpdate();
  }

  /**
   * Play media with fade-in effect
   */
  async playMediaWithFadeIn(media) {
    const { tabId, frameId, mediaId } = media;
    const settings = window.storageManager.get();

    // Store that we're resuming this media
    if (this.pendingResume) {
      this.pendingResume.media = media;
    }

    // Desktop media - no fade-in, just play directly
    if (this.isDesktopMedia(media)) {
      Logger.debug('Resuming desktop media (no fade-in)');
      if (this.desktopConnector) {
        this.desktopConnector.controlDesktopMedia('play', mediaId);
      }
      this.pendingResume = null;
      return;
    }

    const fadeDuration = settings.fadeInDuration;

    // If fade-in is disabled (duration = 0), just play normally
    if (!fadeDuration || fadeDuration <= 0) {
      Logger.debug('Fade-in disabled, playing at full volume');
      try {
        await browser.tabs.sendMessage(tabId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PLAY,
          mediaId,
          frameId
        });
        Logger.success('Playback started (no fade-in)');
      } catch (e) {
        Logger.error('Failed to play media:', e.message);
      }
      this.pendingResume = null;
      return;
    }

    const startVolume = settings.fadeInStartVolume;

    // Try to set volume BEFORE play (works on some elements)
    await this.setMediaVolume(tabId, frameId, mediaId, startVolume);
    Logger.debug('Pre-play volume set to:', (startVolume * 100).toFixed(0) + '%');

    // Start playing
    try {
      await browser.tabs.sendMessage(tabId, {
        type: AUTOSTOP.MSG.CONTROL,
        action: AUTOSTOP.ACTION.PLAY,
        mediaId,
        frameId
      });
      Logger.debug('Play command sent, starting fade-in');
    } catch (e) {
      Logger.error('Failed to play media:', e.message);
      this.pendingResume = null;
      return;
    }

    // Immediately set volume again AFTER play starts (for elements that only accept volume when playing)
    // No delay - do it right away to minimize loud moment
    await this.setMediaVolume(tabId, frameId, mediaId, startVolume);
    Logger.debug('Post-play volume confirmed at:', (startVolume * 100).toFixed(0) + '%');

    // Fade in volume over time
    const fadeSteps = 20; // Number of volume increments
    const stepDuration = fadeDuration / fadeSteps;
    const volumeIncrement = (1 - startVolume) / fadeSteps;
    let currentVolume = startVolume;
    let step = 0;

    const fadeInterval = setInterval(async () => {
      step++;
      currentVolume = Math.min(1, startVolume + (volumeIncrement * step));

      await this.setMediaVolume(tabId, frameId, mediaId, currentVolume);
      Logger.debug(`Fade step ${step}/${fadeSteps}, volume: ${(currentVolume * 100).toFixed(0)}%`);

      if (step >= fadeSteps) {
        clearInterval(fadeInterval);
        Logger.success('Fade-in complete, volume at 100%');
        if (this.pendingResume) {
          this.pendingResume.fadeInterval = null;
          this.pendingResume = null;
        }
      }
    }, stepDuration);

    if (this.pendingResume) {
      this.pendingResume.fadeInterval = fadeInterval;
    }
  }

  /**
   * Set volume for a media element
   */
  async setMediaVolume(tabId, frameId, mediaId, volume) {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: AUTOSTOP.MSG.CONTROL,
        action: AUTOSTOP.ACTION.SET_VOLUME,
        mediaId,
        frameId,
        volume: Math.max(0, Math.min(1, volume))
      });
    } catch (e) {
      Logger.error('Failed to set volume:', e.message);
    }
  }

  /**
   * Reset volume to original (1.0 or stored value)
   */
  async resetVolume(media) {
    const { tabId, frameId, mediaId } = media;
    const originalVolume = this.originalVolumes.get(mediaId) || 1;
    await this.setMediaVolume(tabId, frameId, mediaId, originalVolume);
    Logger.debug('Reset volume to:', originalVolume);
  }

  /**
   * Send play command to a media element
   */
  async playMedia(tabId, frameId, mediaId) {
    const key = this.getMediaKey(tabId, frameId, mediaId);
    if (this.allMedia.has(key)) {
      this.allMedia.get(key).isPlaying = true;
    }

    Logger.debug('Sending play command:', mediaId);

    try {
      await browser.tabs.sendMessage(tabId, {
        type: AUTOSTOP.MSG.CONTROL,
        action: AUTOSTOP.ACTION.PLAY,
        mediaId,
        frameId
      });
    } catch (e) {
      Logger.error('Failed to play media:', e.message);
    }
  }

  /**
   * Send pause command to a media element (browser only)
   */
  async pauseMedia(tabId, frameId, mediaId) {
    const key = this.getMediaKey(tabId, frameId, mediaId);
    if (this.allMedia.has(key)) {
      this.allMedia.get(key).isPlaying = false;
    }

    Logger.debug('Sending pause command:', mediaId);
    try {
      await browser.tabs.sendMessage(tabId, {
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
      // Pause desktop media via connector
      if (this.desktopConnector) {
        this.desktopConnector.controlDesktopMedia('pause', this.activeMedia.mediaId);
      }
    } else {
      // Pause browser media
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
    const isDesktop = mediaId && mediaId.startsWith('desktop-');

    if (isDesktop) {
      await this.controlDesktopMedia(mediaId, action);
      return;
    }

    try {
      if (action === AUTOSTOP.ACTION.PLAY) {
        // Cancel any pending resume since user is manually playing something
        this.cancelPendingResume();

        // Clear the manuallyPaused flag since user is explicitly playing it
        const stackIndex = this.pausedStack.findIndex(m =>
          m.tabId === tabId && m.frameId === frameId && m.mediaId === mediaId
        );
        if (stackIndex !== -1) {
          this.pausedStack.splice(stackIndex, 1);
        }

        await browser.tabs.sendMessage(tabId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PLAY,
          mediaId,
          frameId
        });
      } else if (action === AUTOSTOP.ACTION.PAUSE) {
        // IMPORTANT: Update state BEFORE sending pause command to avoid race condition
        // (content script will send MEDIA_PAUSE back, which could trigger auto-resume)
        let stoppedMedia = null;

        if (this.activeMedia &&
            this.activeMedia.tabId === tabId &&
            this.activeMedia.frameId === frameId &&
            this.activeMedia.mediaId === mediaId) {

          Logger.info('Manual pause via popup, adding to paused stack:', this.activeMedia.title);

          // Store for auto-expire check
          stoppedMedia = { ...this.activeMedia };

          // Remove if already in stack
          this.pausedStack = this.pausedStack.filter(m =>
            !(m.tabId === tabId && m.frameId === frameId && m.mediaId === mediaId)
          );
          this.pausedStack.unshift({
            ...this.activeMedia,
            manuallyPaused: true  // User paused via popup = manual
          });
          this.activeMedia = null;
        }

        // Now send the pause command (after state is already updated)
        await browser.tabs.sendMessage(tabId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PAUSE,
          mediaId,
          frameId
        });

        // Always call scheduleResumePrevious - it handles auto-expire AND resumeOnManualPause
        // Pass wasManualPause=true since this is a user action from popup
        await this.scheduleResumePrevious(null, stoppedMedia, true);
      } else if (action === AUTOSTOP.ACTION.SKIP) {
        await browser.tabs.sendMessage(tabId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.SKIP,
          mediaId,
          frameId
        });
      } else if (action === AUTOSTOP.ACTION.PREV) {
        await browser.tabs.sendMessage(tabId, {
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
      // Cancel any pending resume
      this.cancelPendingResume();

      // Remove from paused stack
      const stackIndex = this.pausedStack.findIndex(m => m.mediaId === mediaId);
      if (stackIndex !== -1) {
        this.pausedStack.splice(stackIndex, 1);
      }

      this.desktopConnector.controlDesktopMedia('play', mediaId);

    } else if (action === AUTOSTOP.ACTION.PAUSE) {
      let stoppedMedia = null;

      if (this.activeMedia && this.activeMedia.mediaId === mediaId) {
        Logger.info('Manual pause of desktop media via popup');
        stoppedMedia = { ...this.activeMedia };

        // Add to paused stack
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

    // Store the active media info for auto-expire check before clearing
    const stoppedMedia = (this.activeMedia && this.activeMedia.tabId === tabId)
      ? { ...this.activeMedia }
      : null;

    // Remove all media from this tab
    for (const [key, media] of this.allMedia.entries()) {
      if (media.tabId === tabId) {
        this.allMedia.delete(key);
        this.originalVolumes.delete(media.mediaId);
      }
    }

    // Remove from paused stack
    const prevLength = this.pausedStack.length;
    this.pausedStack = this.pausedStack.filter(m => m.tabId !== tabId);
    if (this.pausedStack.length !== prevLength) {
      Logger.debug('Removed', prevLength - this.pausedStack.length, 'items from paused stack');
    }

    // Cancel pending resume if it was for this tab (don't put back - tab is closed!)
    if (this.pendingResume?.media?.tabId === tabId) {
      this.cancelPendingResume(false);
    }

    // If active was in this tab, resume previous
    if (stoppedMedia) {
      Logger.info('Active media tab closed:', stoppedMedia.title, '→ Scheduling resume');
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
   * Get current state (includes desktop media)
   */
  getState() {
    // Get desktop state if available
    const desktopState = this.desktopConnector?.getState() || { connected: false, activeMedia: null, pausedList: [] };

    // Combine paused lists - browser first, then desktop
    const combinedPausedStack = [
      ...this.pausedStack,
      ...(desktopState.pausedList || []).map(m => ({ ...m, manuallyPaused: false }))
    ];

    // Deduplicate the combined list
    const seen = new Set();
    const seenDesktopTitles = new Set();
    const deduped = [];

    for (const media of combinedPausedStack) {
      let key;
      let isDuplicate = false;

      if (media.isDesktop) {
        key = `desktop-${media.mediaId}`;
        if (seen.has(key)) {
          isDuplicate = true;
        } else {
          const titleKey = `desktop-${media.appId || 'unknown'}-${(media.title || '').toLowerCase().trim()}`;
          if (seenDesktopTitles.has(titleKey)) {
            isDuplicate = true;
          } else {
            seenDesktopTitles.add(titleKey);
          }
        }
      } else {
        key = `${media.tabId}-${media.frameId}-${media.mediaId}`;
        if (seen.has(key)) {
          isDuplicate = true;
        }
      }

      if (!isDuplicate) {
        seen.add(key);
        deduped.push(media);
      }
    }

    return {
      activeMedia: this.activeMedia,
      pausedStack: deduped,
      allMedia: Array.from(this.allMedia.values()),
      settings: window.storageManager.get(),
      pendingResume: this.pendingResume ? {
        media: this.pendingResume.media,
        isFadingIn: this.pendingResume.fadeInterval !== null
      } : null,
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

    // If active media was desktop, clear it
    if (this.isDesktopMedia(this.activeMedia)) {
      this.activeMedia = null;
    }

    // Remove desktop media from paused stack
    this.pausedStack = this.pausedStack.filter(m => !this.isDesktopMedia(m));

    this.broadcastUpdate();
  }

  /**
   * Deduplicate paused stack - remove exact duplicates
   */
  _deduplicatePausedStack() {
    const seen = new Set();
    const seenDesktopTitles = new Set(); // For desktop media, also dedupe by title
    const deduped = [];

    for (const media of this.pausedStack) {
      let key;
      let isDuplicate = false;

      if (media.isDesktop) {
        // For desktop: use mediaId first, then fall back to title if same app
        key = `desktop-${media.mediaId}`;
        if (seen.has(key)) {
          isDuplicate = true;
        } else {
          // Also check by title for same app (e.g., Spotify with different session IDs)
          const titleKey = `desktop-${media.appId || 'unknown'}-${(media.title || '').toLowerCase().trim()}`;
          if (seenDesktopTitles.has(titleKey)) {
            Logger.debug('Removing duplicate desktop media by title:', media.title);
            isDuplicate = true;
          } else {
            seenDesktopTitles.add(titleKey);
          }
        }
      } else {
        // For browser: use tabId-frameId-mediaId
        key = `${media.tabId}-${media.frameId}-${media.mediaId}`;
        if (seen.has(key)) {
          isDuplicate = true;
        }
      }

      if (!isDuplicate) {
        seen.add(key);
        deduped.push(media);
      } else {
        Logger.debug('Removing duplicate from paused stack:', media.title, `(key: ${key})`);
      }
    }

    if (deduped.length !== this.pausedStack.length) {
      Logger.info(`Deduplicated paused stack: ${this.pausedStack.length} -> ${deduped.length}`);
      this.pausedStack = deduped;
    }
  }

  /**
   * Called when desktop media starts playing
   */
  async onDesktopMediaPlay(desktopMedia) {
    Logger.media('Desktop play', desktopMedia);

    // Cancel any pending resume timeout
    if (this._pendingResumeTimeout) {
      clearTimeout(this._pendingResumeTimeout);
      this._pendingResumeTimeout = null;
      Logger.info('Cancelled pending browser resume timeout - desktop is playing');
    }

    // Cancel any pending resume - desktop is playing now, don't resume browser
    this.cancelPendingResume(false); // Don't put back in stack - desktop is taking over

    // CRITICAL: Save the previous active media BEFORE pausing
    // This prevents it from being lost if pause triggers events
    const previousMedia = this.activeMedia ? { ...this.activeMedia } : null;

    // If there's already active media (browser or other desktop), pause it
    if (previousMedia && previousMedia.mediaId !== desktopMedia.mediaId) {
      Logger.info('Desktop media started, pausing previous:', previousMedia.title);

      // Remove from paused stack first (avoid duplicates)
      this.pausedStack = this.pausedStack.filter(m =>
        !(m.tabId === previousMedia.tabId &&
          m.frameId === previousMedia.frameId &&
          m.mediaId === previousMedia.mediaId)
      );

      // Pause the previously active media
      await this.pauseActiveMedia();

      // Add to paused stack AFTER pausing (using saved copy)
      this.pausedStack.unshift({
        ...previousMedia,
        manuallyPaused: false  // Extension paused it, can auto-resume
      });

      Logger.info('Added previous media to paused stack:', previousMedia.title);
    }

    // Remove desktop from paused stack if it was there
    this.pausedStack = this.pausedStack.filter(m => m.mediaId !== desktopMedia.mediaId);

    // Deduplicate to prevent duplicates
    this._deduplicatePausedStack();

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

    // If this was the active media
    if (this.activeMedia && this.activeMedia.mediaId === desktopMedia.mediaId) {
      // Add to paused stack
      this.pausedStack = this.pausedStack.filter(m => m.mediaId !== desktopMedia.mediaId);
      this.pausedStack.unshift({
        ...desktopMedia,
        manuallyPaused: desktopMedia.manuallyPaused || false  // Preserve manual pause flag from service
      });

      this.activeMedia = null;

      // DO NOT resume browser media when desktop stops
      // User explicitly stopped desktop, so don't auto-resume
      Logger.info('Desktop media stopped - NOT resuming browser (user stopped desktop)');
    }

    this.broadcastUpdate();
  }

  /**
   * Broadcast state update to popup
   */
  broadcastUpdate() {
    // Deduplicate paused stack before broadcasting
    this._deduplicatePausedStack();

    this.updateIcon();

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
