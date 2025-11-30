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

      case AUTOSTOP.ACTION.SET_VOLUME:
        this.adapter.setVolume(mediaId, volume);
        break;
    }
  }
}

// Make available globally
window.MediaDetector = MediaDetector;

