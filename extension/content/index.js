// Auto-Stop Media - Content Script Entry Point

(function() {
  'use strict';

  // Avoid double injection
  if (window._autoStopInjected) {
    Logger.debug('Already injected, skipping');
    return;
  }
  window._autoStopInjected = true;

  Logger.info('Content script loading on:', window.location.hostname);

  // Initialize when DOM is ready
  function initialize() {
    try {
      window._autoStopDetector = new MediaDetector();
      window._autoStopDetector.init();
    } catch (e) {
      Logger.error('Failed to initialize:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();

