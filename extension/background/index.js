// Auto-Stop Media - Background Script Entry Point

(async function() {
  'use strict';

  Logger.info('Background script starting...');

  // Initialize storage
  await window.storageManager.load();

  // Initialize desktop connector
  const desktopConnector = new window.DesktopConnector(window.mediaManager);
  window.mediaManager.setDesktopConnector(desktopConnector);
  window.desktopConnector = desktopConnector;

  // Start desktop connector (will auto-reconnect if service isn't running)
  desktopConnector.init();

  // Message handler
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId || 0;
    const tab = sender.tab;

    switch (message.type) {
      // Content script messages
      case AUTOSTOP.MSG.MEDIA_REGISTERED:
        window.mediaManager.handleMediaRegistered(tabId, frameId, message.data, tab);
        break;

      case AUTOSTOP.MSG.MEDIA_UNREGISTERED:
        window.mediaManager.handleMediaUnregistered(tabId, frameId, message.data);
        break;

      case AUTOSTOP.MSG.MEDIA_PLAY:
        window.mediaManager.handleMediaPlay(tabId, frameId, message.data, tab);
        break;

      case AUTOSTOP.MSG.MEDIA_PAUSE:
        window.mediaManager.handleMediaPause(tabId, frameId, message.data);
        break;

      case AUTOSTOP.MSG.MEDIA_ENDED:
        window.mediaManager.handleMediaEnded(tabId, frameId, message.data);
        break;

      case AUTOSTOP.MSG.TIME_UPDATE:
        window.mediaManager.handleTimeUpdate(tabId, frameId, message.data);
        break;

      // Popup messages
      case AUTOSTOP.MSG.GET_STATE:
        return Promise.resolve(window.mediaManager.getState());

      case AUTOSTOP.MSG.GET_SETTINGS:
        return Promise.resolve(window.storageManager.get());

      case AUTOSTOP.MSG.UPDATE_SETTINGS:
        return window.storageManager.update(message.data);

      case AUTOSTOP.MSG.CONTROL_MEDIA:
        window.mediaManager.controlMedia(message.data);
        break;
    }
  });

  // Handle tab closed
  browser.tabs.onRemoved.addListener((tabId) => {
    window.mediaManager.handleTabClosed(tabId);
  });

  // Update favicon when tab updates
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.favIconUrl) {
      window.mediaManager.updateTabFavicon(tabId, changeInfo.favIconUrl);
    }
  });

  Logger.success('Background script ready');
})();

