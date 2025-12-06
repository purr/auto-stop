// Auto-Stop Media - Desktop Connector
// Handles WebSocket connection to Windows service for desktop media control

// =============================================================================
// CONFIGURATION - Easy to modify values
// =============================================================================
const DESKTOP_CONFIG = {
  WS_URL: 'ws://127.0.0.1:42089',       // WebSocket server address
  MAX_RECONNECT_ATTEMPTS: 10,            // Max reconnection attempts before backing off
  RECONNECT_DELAY_BASE: 1000,            // Base delay between reconnects (ms)
  RECONNECT_DELAY_MAX: 30000,            // Maximum reconnect delay (ms)
  CONNECTION_CHECK_INTERVAL: 10000,      // How often to check connection status (ms)
  PAUSE_DEBOUNCE_DELAY: 1000,            // Delay before confirming desktop stopped (ms)
  PING_INTERVAL: 15000,                  // How often to send ping (ms)
  PING_TIMEOUT: 5000                     // How long to wait for pong (ms)
};

class DesktopConnector {
  constructor(mediaManager) {
    this.mediaManager = mediaManager;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = DESKTOP_CONFIG.MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = DESKTOP_CONFIG.RECONNECT_DELAY_BASE;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.pingTimeout = null;
    this.lastPongTime = 0;

    // Desktop media state
    this.desktopState = {
      activeMedia: null,
      pausedList: []
    };

    // Debounce timer for desktop pause (prevents false triggers during transitions)
    this._pauseDebounceTimer = null;

    // WebSocket server config
    this.wsUrl = DESKTOP_CONFIG.WS_URL;
  }

  /**
   * Initialize the connector and attempt to connect
   */
  init() {
    Logger.info('Desktop connector initializing...');
    this.connect();

    // Periodically check connection and reconnect if needed
    setInterval(() => {
      const wsConnected = this.ws && this.ws.readyState === WebSocket.OPEN;

      if (this.connected && !wsConnected) {
        Logger.warn('WebSocket state mismatch - marking as disconnected');
        this.handleDisconnect();
      }

      if (!wsConnected && !this.reconnectTimer) {
        Logger.debug('Periodic reconnect check - attempting connection');
        this.reconnectAttempts = 0;
        this.connect();
      }
    }, DESKTOP_CONFIG.CONNECTION_CHECK_INTERVAL);
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

        this.startPing();

        // Register browser
        this.send({
          type: 'REGISTER_BROWSER',
          data: {
            browser: 'firefox',
            userAgent: navigator.userAgent
          }
        });

        // Send current browser state
        this.sendBrowserState();

        // Request initial desktop state
        this.send({ type: 'GET_DESKTOP_STATE' });

        this.mediaManager.onDesktopConnected();
      };

      this.ws.onclose = (event) => {
        Logger.info('Disconnected from desktop service:', event.code, event.reason);
        this.handleDisconnect();
      };

      this.ws.onerror = () => {
        Logger.debug('Desktop service connection error (service may not be running)');
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

    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    this.desktopState = { activeMedia: null, pausedList: [] };

    if (wasConnected) {
      this.mediaManager.onDesktopDisconnected();
    }

    // Schedule reconnect
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), DESKTOP_CONFIG.RECONNECT_DELAY_MAX);
      Logger.debug(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    } else {
      Logger.debug('Max reconnect attempts reached. Will retry in 10s.');
      this.reconnectAttempts = 0;
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

    this.desktopState = state;

    Logger.debug('Desktop state update:', {
      prevActive: prevActive?.title,
      newActive: newActive?.title,
      pausedCount: state.pausedList?.length || 0
    });

    // Desktop media started playing
    if (newActive && !prevActive) {
      // Cancel any pending pause notification - desktop is active!
      this.clearPauseDebounce();
      Logger.media('Desktop media started', newActive);
      this.mediaManager.onDesktopMediaPlay(newActive);
    }
    // Desktop still active - check for changes
    else if (newActive && prevActive) {
      // Cancel any pending pause notification - desktop is still active
      this.clearPauseDebounce();

      const titleChanged = newActive.title !== prevActive.title;
      const mediaIdChanged = newActive.mediaId !== prevActive.mediaId;
      const isPlayingChanged = newActive.isPlaying !== prevActive.isPlaying;

      if (titleChanged || mediaIdChanged) {
        Logger.media('Desktop media changed', newActive);
        this.mediaManager.onDesktopMediaPlay(newActive);
      } else if (isPlayingChanged && !newActive.isPlaying) {
        Logger.media('Desktop media paused/ended', newActive);
        this.mediaManager.onDesktopMediaPause(newActive);
      } else if (!newActive.isPlaying) {
        // CRITICAL: If isPlaying is false (even if unchanged), treat as pause
        // This handles cases where Python service is frozen and keeps sending stale state
        Logger.media('Desktop media not playing (stale state?)', newActive);
        this.mediaManager.onDesktopMediaPause(newActive);
      } else {
        // Just progress update (and isPlaying is true)
        if (this.mediaManager.activeMedia && this.mediaManager.activeMedia.mediaId === newActive.mediaId) {
          this.mediaManager.activeMedia.currentTime = newActive.currentTime || 0;
          this.mediaManager.activeMedia.duration = newActive.duration || 0;
          this.mediaManager.activeMedia.isPlaying = newActive.isPlaying;
          this.mediaManager.activeMedia.cover = newActive.cover || this.mediaManager.activeMedia.cover;
        }
      }
    }
    // Desktop media stopped - debounce to avoid false triggers during transitions
    else if (!newActive && prevActive) {
      Logger.debug('Desktop media stopped - debouncing...');
      this.debouncedPause(prevActive);
    }

    this.mediaManager.broadcastUpdate();
  }

  /**
   * Debounce desktop pause to avoid false triggers during state transitions
   */
  debouncedPause(prevActive) {
    this.clearPauseDebounce();

    // Wait before confirming desktop stopped
    // This handles brief gaps during track changes or app startup
    this._pauseDebounceTimer = setTimeout(() => {
      this._pauseDebounceTimer = null;

      // Double-check desktop is still not active
      if (!this.desktopState.activeMedia) {
        Logger.media('Desktop media stopped (confirmed)', prevActive);
        this.mediaManager.onDesktopMediaPause(prevActive);
      } else {
        Logger.debug('Desktop pause cancelled - desktop became active again');
      }
    }, DESKTOP_CONFIG.PAUSE_DEBOUNCE_DELAY);
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
   * Send current browser media state to desktop service
   */
  sendBrowserState() {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const hasActiveMedia = this.mediaManager.activeMedia !== null;
    const activeMedia = this.mediaManager.activeMedia;

    this.send({
      type: 'BROWSER_STATE_SYNC',
      data: {
        hasActiveMedia: hasActiveMedia,
        activeMedia: hasActiveMedia ? {
          title: activeMedia.title || 'Unknown',
          mediaId: activeMedia.mediaId || '',
          isPlaying: activeMedia.isPlaying !== false
        } : null
      }
    });
  }

  /**
   * Send message to desktop service
   */
  send(message) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
   * Start ping interval
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

      const sent = this.send({ type: 'PING' });
      if (!sent) {
        Logger.warn('Failed to send ping');
        this.handleDisconnect();
        return;
      }

      this.pingTimeout = setTimeout(() => {
        Logger.warn('Ping timeout - no pong received');
        this.handleDisconnect();
      }, DESKTOP_CONFIG.PING_TIMEOUT);

    }, DESKTOP_CONFIG.PING_INTERVAL);
  }

  /**
   * Stop ping interval
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
