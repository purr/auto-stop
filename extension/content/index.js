// Auto-Stop Media - Content Script Entry Point
// Runs at document_start so the capture listeners are attached before any media plays.

(function () {
  'use strict';

  if (window._autoStopInjected) return;
  window._autoStopInjected = true;

  try {
    window._autoStopController = new MediaController();
    window._autoStopController.init();
  } catch (e) {
    Logger.error('Failed to initialize media controller:', e);
  }
})();
