// Auto-Stop Media - Media Manager
// Manages media state across all tabs

class MediaManager {
  constructor() {
    // Currently active media
    this.activeMedia = null; // { tabId, frameId, mediaId, url, title, favicon, startedAt, ... }

    // Stack of paused media (most recent first)
    // Each item has: { ...mediaInfo, manuallyPaused: boolean }
    // manuallyPaused = true means user paused it, won't auto-resume
    // manuallyPaused = false means extension paused it, can auto-resume
    this.pausedStack = [];

    // All known media elements
    this.allMedia = new Map(); // key: `${tabId}-${frameId}-${mediaId}`

    // Resume state management
    this.pendingResume = null;      // { timeoutId, media, fadeInterval }
    this.originalVolumes = new Map(); // mediaId -> original volume (0-1)
  }

  /**
   * Generate a unique key for media
   */
  getMediaKey(tabId, frameId, mediaId) {
    return `${tabId}-${frameId}-${mediaId}`;
  }

  /**
   * Handle media registration
   */
  async handleMediaRegistered(tabId, frameId, data, tab) {
    const url = tab?.url || '';

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

    Logger.media('Play event', { title: data.title, url });

    // Cancel any pending resume - new media is playing!
    this.cancelPendingResume();

    // Check Blacklist - Blacklisted media is completely ignored
    if (window.storageManager.isBlacklisted(url)) {
      Logger.debug('Blacklisted media play ignored:', url);
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

    // If there's already active media and it's not this one
    if (this.activeMedia &&
        !(this.activeMedia.tabId === tabId &&
          this.activeMedia.frameId === frameId &&
          this.activeMedia.mediaId === data.mediaId)) {

      Logger.info('New media started, pausing previous:', this.activeMedia.title);

      // Pause the previously active media
      await this.pauseMedia(
        this.activeMedia.tabId,
        this.activeMedia.frameId,
        this.activeMedia.mediaId
      );

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

    // Set as active with timestamp
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
      startedAt: Date.now() // Track when this media started playing
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

      this.activeMedia = null;

      // Try to auto-resume previous media
      // findNextAutoResumable() will skip any items with manuallyPaused: true
      const settings = window.storageManager.get();

      if (!data.manual || settings.resumeOnManualPause) {
        // Try to resume - will skip any manually-paused items in the stack
        // Pass stoppedMedia for auto-expire check
        await this.scheduleResumePrevious(null, stoppedMedia);
      } else {
        Logger.info('Manual pause with resumeOnManualPause=false - not auto-resuming');
        this.broadcastUpdate();
      }
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
   * Handle time update from content script
   */
  handleTimeUpdate(tabId, frameId, data) {
    const key = this.getMediaKey(tabId, frameId, data.mediaId);

    // Update in allMedia
    if (this.allMedia.has(key)) {
      const media = this.allMedia.get(key);
      media.currentTime = data.currentTime;
      media.duration = data.duration || media.duration;
    }

    // Update active media if this is it
    if (this.activeMedia &&
        this.activeMedia.tabId === tabId &&
        this.activeMedia.frameId === frameId &&
        this.activeMedia.mediaId === data.mediaId) {
      this.activeMedia.currentTime = data.currentTime;
      this.activeMedia.duration = data.duration || this.activeMedia.duration;
      this.activeMedia.playbackRate = data.playbackRate || 1;

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
   */
  async scheduleResumePrevious(specificMedia = null, stoppedMedia = null) {
    // Cancel any existing pending resume
    this.cancelPendingResume();

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

    const settings = window.storageManager.get();

    // Check auto-expire: if the stopped media played too long, don't auto-resume
    // stoppedMedia contains the startedAt timestamp from when it started playing
    if (stoppedMedia && settings.autoExpireSeconds > 0) {
      const playDuration = (Date.now() - (stoppedMedia.startedAt || Date.now())) / 1000;
      if (playDuration >= settings.autoExpireSeconds) {
        Logger.info(`Auto-expire: Media played for ${Math.round(playDuration)}s (threshold: ${settings.autoExpireSeconds}s), not resuming`);
        // Put it back in the stack so user can manually resume
        this.pausedStack.unshift(toResume);
        this.broadcastUpdate();
        return;
      }
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
   * Resume the most recently paused media (legacy - now uses scheduleResumePrevious)
   */
  async resumePreviousMedia() {
    await this.scheduleResumePrevious();
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
   * Send pause command to a media element
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
   * Handle control command from popup
   */
  async controlMedia(data) {
    const { tabId, frameId, mediaId, action } = data;

    Logger.info('Popup control:', action, mediaId);

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
        let shouldTryResume = false;
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

          // Check if we should try to resume previous media
          const settings = window.storageManager.get();
          if (settings.resumeOnManualPause) {
            shouldTryResume = true;
          }
        }

        // Now send the pause command (after state is already updated)
        await browser.tabs.sendMessage(tabId, {
          type: AUTOSTOP.MSG.CONTROL,
          action: AUTOSTOP.ACTION.PAUSE,
          mediaId,
          frameId
        });

        // Try to resume previous media if setting is enabled
        if (shouldTryResume) {
          Logger.info('resumeOnManualPause is enabled, trying to resume previous media');
          await this.scheduleResumePrevious(null, stoppedMedia);
        }
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
   * Get current state
   */
  getState() {
    return {
      activeMedia: this.activeMedia,
      pausedStack: this.pausedStack,
      allMedia: Array.from(this.allMedia.values()),
      settings: window.storageManager.get(),
      pendingResume: this.pendingResume ? {
        media: this.pendingResume.media,
        isFadingIn: this.pendingResume.fadeInterval !== null
      } : null
    };
  }

  /**
   * Broadcast state update to popup
   */
  broadcastUpdate() {
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
