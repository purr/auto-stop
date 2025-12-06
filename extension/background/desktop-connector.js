// Auto-Stop Media - Desktop Connector
// Handles WebSocket connection to Windows service for desktop media control

class DesktopConnector {
  constructor(mediaManager) {
    this.mediaManager = mediaManager;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.pingTimeout = null;
    this.lastPongTime = 0;
    this._pauseDebounceTimer = null;
    this._desktopPlayInProgress = false; // Flag to prevent false pauses during desktop startup
    this._desktopLastActiveTime = 0; // Timestamp when desktop was last active
    this._desktopPlayTimeout = null; // Timeout ID for clearing the play flag

    // Desktop media state
    this.desktopState = {
      activeMedia: null,
      pausedList: []
    };

    // WebSocket server config
    this.wsUrl = 'ws://127.0.0.1:42089';
  }

  /**
   * Initialize the connector and attempt to connect
   */
  init() {
    Logger.info('Desktop connector initializing...');
    this.connect();

    // Periodically check connection and reconnect if needed
    setInterval(() => {
      // Check if WebSocket is actually connected
      const wsConnected = this.ws && this.ws.readyState === WebSocket.OPEN;

      // Update connected state based on actual WebSocket state
      if (this.connected && !wsConnected) {
        Logger.warn('WebSocket state mismatch - marking as disconnected');
        this.handleDisconnect();
      }

      // Try to reconnect if not connected
      if (!wsConnected && !this.reconnectTimer) {
        Logger.debug('Periodic reconnect check - attempting connection');
        this.reconnectAttempts = 0; // Reset attempts for periodic check
        this.connect();
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Connect to the Windows service WebSocket
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    Logger.debug('Attempting to connect to desktop service...');

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        Logger.success('Connected to desktop service');
        this.connected = true;
        this.reconnectAttempts = 0;

        // Start ping interval
        this.startPing();

        // Register browser info so service can filter it out
        this.send({
          type: 'REGISTER_BROWSER',
          data: {
            browser: 'firefox',
            userAgent: navigator.userAgent
          }
        });

        // Request initial state
        this.send({ type: 'GET_DESKTOP_STATE' });

        // Notify media manager
        this.mediaManager.onDesktopConnected();
      };

      this.ws.onclose = (event) => {
        Logger.info('Disconnected from desktop service:', event.code, event.reason);
        this.handleDisconnect();
      };

      this.ws.onerror = (error) => {
        Logger.debug('Desktop service connection error (service may not be running)');
        // Don't log full error - it's expected when service isn't running
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

    } catch (e) {
      Logger.debug('Failed to create WebSocket:', e.message);
      this.handleDisconnect();
    }
  }

  /**
   * Handle disconnection
   */
  handleDisconnect() {
    const wasConnected = this.connected;
    this.connected = false;
    this.stopPing();
    this.clearPauseDebounce();

    // Close WebSocket if still exists
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    // Clear desktop state
    this.desktopState = { activeMedia: null, pausedList: [] };

    // Always notify media manager of disconnection (for UI update)
    if (wasConnected) {
      this.mediaManager.onDesktopDisconnected();
    }

    // Schedule reconnect
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
      Logger.debug(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    } else {
      Logger.debug('Max reconnect attempts reached. Will retry in 10s.');
      this.reconnectAttempts = 0; // Reset for next cycle
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(raw) {
    try {
      const message = JSON.parse(raw);
      const { type, data } = message;

      Logger.debug('Desktop message:', type);

      switch (type) {
        case 'PONG':
          // Heartbeat response - connection is alive
          this.lastPongTime = Date.now();
          if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
          }
          break;

        case 'DESKTOP_STATE_UPDATE':
          this.handleStateUpdate(data);
          break;

        default:
          Logger.debug('Unknown desktop message type:', type);
      }

    } catch (e) {
      Logger.error('Failed to parse desktop message:', e);
    }
  }

  /**
   * Handle desktop state update
   */
  handleStateUpdate(state) {
    const prevActive = this.desktopState.activeMedia;
    const newActive = state.activeMedia;

    // Store previous state for comparison
    const prevState = this.desktopState;
    this.desktopState = state;

    // Log state for debugging
    Logger.debug('Desktop state update:', {
      prevActive: prevActive?.title,
      newActive: newActive?.title,
      pausedCount: state.pausedList?.length || 0,
      playInProgress: this._desktopPlayInProgress
    });

    // CRITICAL: Set flag early if ANY desktop media exists (active or paused)
    // This prevents false pauses during startup transitions
    const hasDesktopMedia = newActive || (state.pausedList && state.pausedList.some(m => m.isDesktop));
    if (hasDesktopMedia) {
      // Always update timestamp when desktop media exists
      this._desktopLastActiveTime = Date.now();

      // Set flag if not already set, or extend it if already set
      if (!this._desktopPlayInProgress) {
        Logger.debug('Desktop media detected - setting play flag to prevent false pauses');
        this._desktopPlayInProgress = true;
      }

      // Always reset/extend the timeout when desktop media exists
      if (this._desktopPlayTimeout) {
        clearTimeout(this._desktopPlayTimeout);
      }
      this._desktopPlayTimeout = setTimeout(() => {
        this._desktopPlayInProgress = false;
        Logger.debug('Desktop play flag cleared after timeout');
      }, 10000); // 10 seconds to be very safe
    }

    // Notify media manager of changes
    if (newActive && !prevActive) {
      // Desktop media started playing
      Logger.media('Desktop media started', newActive);
      this.clearPauseDebounce();
      // Set flag to prevent false pause during startup
      this._desktopPlayInProgress = true;
      // Update timestamp
      this._desktopLastActiveTime = Date.now();
      // Clear flag after a delay (desktop should be stable by then)
      if (this._desktopPlayTimeout) {
        clearTimeout(this._desktopPlayTimeout);
      }
      this._desktopPlayTimeout = setTimeout(() => {
        this._desktopPlayInProgress = false;
        Logger.debug('Desktop play flag cleared after timeout');
      }, 10000); // 10 seconds
      // IMPORTANT: Clear any pending resume that might have been triggered by a false pause
      this.mediaManager.cancelPendingResume(false); // Don't put back in stack - desktop is playing now
      // Also cancel any pending resume timeout
      if (this.mediaManager._pendingResumeTimeout) {
        clearTimeout(this.mediaManager._pendingResumeTimeout);
        this.mediaManager._pendingResumeTimeout = null;
        Logger.info('Cancelled pending browser resume timeout from desktop connector');
      }
      this.mediaManager.onDesktopMediaPlay(newActive);
    } else if (newActive && prevActive) {
      // Desktop is still active - check if it's a different track or just an update
      const titleChanged = newActive.title !== prevActive.title;
      const mediaIdChanged = newActive.mediaId !== prevActive.mediaId;
      const isPlayingChanged = newActive.isPlaying !== prevActive.isPlaying;

      // Update timestamp
      this._desktopLastActiveTime = Date.now();

      if (titleChanged || mediaIdChanged) {
        // Different track started - clear any pending pause
        Logger.media('Desktop media changed', newActive);
        this.clearPauseDebounce();
        this.mediaManager.onDesktopMediaPlay(newActive);
      } else if (isPlayingChanged && !newActive.isPlaying) {
        // Same track but stopped playing (manually paused or ended)
        Logger.media('Desktop media paused/ended', newActive);
        this.mediaManager.onDesktopMediaPause(newActive);
      } else {
        // Same track - just update progress/metadata
        if (this.mediaManager.activeMedia && this.mediaManager.activeMedia.mediaId === newActive.mediaId) {
          this.mediaManager.activeMedia.currentTime = newActive.currentTime || 0;
          this.mediaManager.activeMedia.duration = newActive.duration || 0;
          this.mediaManager.activeMedia.isPlaying = newActive.isPlaying;
          this.mediaManager.activeMedia.cover = newActive.cover || this.mediaManager.activeMedia.cover;
          // Preserve manuallyPaused flag if it exists
          if (newActive.manuallyPaused !== undefined) {
            this.mediaManager.activeMedia.manuallyPaused = newActive.manuallyPaused;
          }
          Logger.debug('Desktop progress update:', {
            currentTime: newActive.currentTime,
            duration: newActive.duration,
            isPlaying: newActive.isPlaying,
            manuallyPaused: newActive.manuallyPaused
          });
        }
      }
    } else if (!newActive && prevActive) {
      // Desktop media stopped - IMMEDIATELY clear active media (don't wait for debounce)
      Logger.media('Desktop media stopped', prevActive);
      this.mediaManager.onDesktopMediaPause(prevActive);

      // Debounce to avoid false triggers during track changes
      // BUT: Only debounce if we're not currently in the middle of a desktop play event
      // AND if there's no desktop media anywhere (might be starting)
      if (!this._desktopPlayInProgress && !hasDesktopMedia) {
        Logger.debug('Desktop media stopped (debouncing additional actions)');
        this.debouncedPause(prevActive);
      } else {
        if (this._desktopPlayInProgress) {
          Logger.debug('Desktop media stopped - ignoring (play in progress)');
        } else {
          Logger.debug('Desktop media stopped - ignoring (desktop media exists, might be transitioning)');
        }
      }
    }

    // Update desktop media in paused stack if it exists there
    // This ensures manuallyPaused flag and other metadata stay in sync
    if (state.pausedList && state.pausedList.length > 0) {
      for (const pausedMedia of state.pausedList) {
        if (pausedMedia.isDesktop) {
          // Find and update this desktop media in the paused stack
          const index = this.mediaManager.pausedStack.findIndex(m =>
            m.isDesktop && m.mediaId === pausedMedia.mediaId
          );
          if (index !== -1) {
            // Update the paused media with latest info (including manuallyPaused)
            this.mediaManager.pausedStack[index] = {
              ...this.mediaManager.pausedStack[index],
              ...pausedMedia,
              manuallyPaused: pausedMedia.manuallyPaused || false
            };
          }
        }
      }
    }

    // Always broadcast update to popup (for progress, cover, etc.)
    this.mediaManager.broadcastUpdate();
  }

  /**
   * Debounce pause to avoid false triggers during track changes
   */
  debouncedPause(prevActive) {
    // Clear any existing debounce
    this.clearPauseDebounce();

    // Wait 4 seconds before considering it a real pause
    // Track changes in Spotify etc. often have brief pauses
    this._pauseDebounceTimer = setTimeout(() => {
      this._pauseDebounceTimer = null;
      // Check current state - if still no active media AND not in play progress, it's a real pause
      // Also check if there's ANY desktop media (active or paused) - might be starting/transitioning
      // Also check if desktop was recently active (within last 5 seconds) - might be transitioning
      const hasDesktopActive = !!this.desktopState.activeMedia;
      const hasDesktopInPaused = this.desktopState.pausedList &&
        this.desktopState.pausedList.some(m => m.isDesktop);
      const hasAnyDesktopMedia = hasDesktopActive || hasDesktopInPaused;
      const recentlyActive = (Date.now() - this._desktopLastActiveTime) < 5000; // Within last 5 seconds

      if (!hasDesktopActive && !this._desktopPlayInProgress && !hasAnyDesktopMedia && !recentlyActive) {
        Logger.media('Desktop media stopped (confirmed)', prevActive);
        this.mediaManager.onDesktopMediaPause(prevActive);
      } else {
        if (this._desktopPlayInProgress) {
          Logger.debug('Desktop pause cancelled - play in progress');
        } else if (hasDesktopActive) {
          Logger.debug('Desktop pause cancelled - desktop is active');
        } else if (hasDesktopInPaused) {
          Logger.debug('Desktop pause cancelled - desktop in paused list (might be starting)');
        } else if (recentlyActive) {
          Logger.debug('Desktop pause cancelled - desktop was recently active (might be transitioning)');
        } else {
          Logger.debug('Desktop pause cancelled - unknown reason');
        }
      }
    }, 4000); // Increased to 4 seconds for more stability
  }

  /**
   * Clear pause debounce timer
   */
  clearPauseDebounce() {
    if (this._pauseDebounceTimer) {
      clearTimeout(this._pauseDebounceTimer);
      this._pauseDebounceTimer = null;
    }
  }

  /**
   * Send message to desktop service
   */
  send(message) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Logger.debug('Cannot send - not connected to desktop service');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      Logger.error('Failed to send to desktop service:', e);
      return false;
    }
  }

  /**
   * Start ping interval with timeout detection
   */
  startPing() {
    this.stopPing();
    this.lastPongTime = Date.now();

    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        Logger.warn('Ping failed - WebSocket not open');
        this.handleDisconnect();
        return;
      }

      // Send ping
      const sent = this.send({ type: 'PING' });
      if (!sent) {
        Logger.warn('Failed to send ping');
        this.handleDisconnect();
        return;
      }

      // Set timeout for pong response
      this.pingTimeout = setTimeout(() => {
        Logger.warn('Ping timeout - no pong received');
        this.handleDisconnect();
      }, 5000); // 5 second timeout for pong

    }, 15000); // Ping every 15 seconds
  }

  /**
   * Stop ping interval and timeout
   */
  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  /**
   * Notify desktop service that browser media started playing
   */
  notifyBrowserMediaPlay(mediaInfo) {
    this.send({
      type: 'MEDIA_PLAY',
      data: mediaInfo
    });
  }

  /**
   * Notify desktop service that browser media paused
   */
  notifyBrowserMediaPause(mediaInfo) {
    this.send({
      type: 'MEDIA_PAUSE',
      data: mediaInfo
    });
  }

  /**
   * Notify desktop service that browser media ended
   */
  notifyBrowserMediaEnded(mediaInfo) {
    this.send({
      type: 'MEDIA_ENDED',
      data: mediaInfo
    });
  }

  /**
   * Control desktop media
   */
  controlDesktopMedia(action, mediaId) {
    Logger.info('Controlling desktop media:', action, mediaId);
    return this.send({
      type: 'CONTROL',
      data: { action, mediaId }
    });
  }

  /**
   * Get current desktop state
   */
  getState() {
    // Verify actual connection state
    const actuallyConnected = this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;

    return {
      connected: actuallyConnected,
      ...this.desktopState
    };
  }

  /**
   * Check if a media ID is desktop media
   */
  isDesktopMedia(mediaId) {
    return mediaId && mediaId.startsWith('desktop-');
  }
}

// Make available globally
window.DesktopConnector = DesktopConnector;

