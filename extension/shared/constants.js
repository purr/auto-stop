// Auto-Stop Media - Shared Constants

// Universal Logger with prefix for easy console filtering
const Logger = {
  PREFIX: '[AutoStop]',

  log: (...args) => console.log(Logger.PREFIX, ...args),
  info: (...args) => console.info(Logger.PREFIX, '📘', ...args),
  warn: (...args) => console.warn(Logger.PREFIX, '⚠️', ...args),
  error: (...args) => console.error(Logger.PREFIX, '❌', ...args),
  debug: (...args) => console.debug(Logger.PREFIX, '🔍', ...args),
  success: (...args) => console.log(Logger.PREFIX, '✅', ...args),

  // Grouped logging for complex data
  group: (label, fn) => {
    console.groupCollapsed(Logger.PREFIX, label);
    fn();
    console.groupEnd();
  },

  // Media-specific logging
  media: (action, data) => {
    console.log(Logger.PREFIX, '🎵', action, data?.title || data?.mediaId || data);
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.Logger = Logger;
}

const AUTOSTOP = {
  // Message types
  MSG: {
    // Content -> Background
    MEDIA_REGISTERED: 'MEDIA_REGISTERED',
    MEDIA_UNREGISTERED: 'MEDIA_UNREGISTERED',
    MEDIA_PLAY: 'MEDIA_PLAY',
    MEDIA_PAUSE: 'MEDIA_PAUSE',
    MEDIA_ENDED: 'MEDIA_ENDED',
    TIME_UPDATE: 'TIME_UPDATE',

    // Background -> Content
    CONTROL: 'CONTROL',

    // Popup <-> Background
    GET_STATE: 'GET_STATE',
    GET_SETTINGS: 'GET_SETTINGS',
    UPDATE_SETTINGS: 'UPDATE_SETTINGS',
    CONTROL_MEDIA: 'CONTROL_MEDIA',
    STATE_UPDATE: 'STATE_UPDATE'
  },

  // Control actions
  ACTION: {
    PLAY: 'play',
    PAUSE: 'pause',
    SKIP: 'skip',
    PREV: 'prev',
    SET_VOLUME: 'setVolume'
  },

  // Default settings
  DEFAULT_SETTINGS: {
    Blacklist: [],
    // Resume behavior
    resumeDelay: 1500,        // ms to wait before resuming (prevents accidental playback)
    fadeInDuration: 2000,     // ms for volume fade-in
    fadeInStartVolume: 0.2,   // Start volume (0-1) when fading in
    // Auto-expire: don't resume if new media played longer than this (0 = disabled)
    autoExpireSeconds: 0,     // seconds (e.g., 120 = 2 min, 0 = always resume)
    // Resume on manual pause: try to resume previous media when you manually pause current
    resumeOnManualPause: true // If false, manual pause = no auto-resume at all
  },

  // Site identifiers
  SITE: {
    SOUNDCLOUD: 'soundcloud',
    YOUTUBE: 'youtube',
    SPOTIFY: 'spotify',
    GENERIC: 'generic'
  }
};

// Make available in both contexts
if (typeof window !== 'undefined') {
  window.AUTOSTOP = AUTOSTOP;
}

