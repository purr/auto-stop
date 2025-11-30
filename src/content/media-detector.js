// Auto-Stop Media - Media Detector
// Main content script coordinator

class MediaDetector {
  constructor() {
    this.adapter = null;
  }

  init() {
    // Get the appropriate adapter
    this.adapter = window.adapterRegistry.init();

    // Listen for control messages from background
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message);
    });

    Logger.success('Media detector initialized');
  }

  handleMessage(message) {
    // Handle PING from background (heartbeat check)
    if (message.type === 'PING') {
      this.handlePing(message.mediaId);
      return;
    }

    if (message.type !== AUTOSTOP.MSG.CONTROL) return;
    if (!this.adapter) return;

    const { action, mediaId, volume } = message;

    Logger.debug('Control message:', action, mediaId);

    switch (action) {
      case AUTOSTOP.ACTION.PLAY:
        this.adapter.play(mediaId);
        break;

      case AUTOSTOP.ACTION.PAUSE:
        this.adapter.pause(mediaId);
        break;

      case AUTOSTOP.ACTION.SKIP:
        this.adapter.skip(mediaId);
        break;

      case AUTOSTOP.ACTION.PREV:
        this.adapter.prev(mediaId);
        break;

      case AUTOSTOP.ACTION.SET_VOLUME:
        this.adapter.setVolume(mediaId, volume);
        break;
    }
  }

  /**
   * Handle PING from background - verify media state and respond
   */
  handlePing(mediaId) {
    if (!this.adapter) return;

    Logger.debug('Received PING for mediaId:', mediaId);

    // Check if we have any playing media
    const allMedia = document.querySelectorAll('video, audio');
    for (const element of allMedia) {
      if (!element.paused && !element.ended && element.duration > 1) {
        // Found playing media - send play event to sync state
        const currentMediaId = element._autoStopMediaId || mediaId;

        // Re-register if needed
        if (!element._autoStopMediaId) {
          Logger.info('PING: Found untracked playing media, registering');
          if (this.adapter.registerMediaElement) {
            this.adapter.registerMediaElement(element);
          }
        } else {
          // Send updated info
          const info = this.adapter.getMediaInfo(element, currentMediaId);
          this.adapter.sendMessage(AUTOSTOP.MSG.MEDIA_PLAY, info);
        }
        return;
      }
    }

    // No playing media found - the background's active media is stale
    Logger.info('PING: No playing media found');
  }
}

// Make available globally
window.MediaDetector = MediaDetector;

