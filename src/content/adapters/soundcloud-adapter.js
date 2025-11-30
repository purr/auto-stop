// Auto-Stop Media - SoundCloud Adapter
// Handles SoundCloud's custom player
// Reference: https://github.com/JohannesFischer/soundcloud-control

class SoundCloudAdapter extends BaseAdapter {
  constructor() {
    super();
    this.name = 'soundcloud';
    this.currentMediaId = null;
    this.isPlaying = false;
    this.pollInterval = null;
    this.registered = false;
  }

  matches() {
    return window.location.hostname.includes('soundcloud.com');
  }

  get priority() {
    return 100; // High priority for SoundCloud
  }

  init() {
    super.init();

    // Wait for SoundCloud's player to be ready
    this.waitForPlayer();
  }

  waitForPlayer() {
    const checkPlayer = () => {
      const playButton = this.getPlayButton();
      if (playButton) {
        Logger.success('SoundCloud: Player found');
        this.setupPlayer();
      } else {
        setTimeout(checkPlayer, 500);
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkPlayer);
    } else {
      checkPlayer();
    }
  }

  setupPlayer() {
    // Generate ID but don't register yet
    this.currentMediaId = this.generateMediaId();

    // Set up polling to detect play state changes
    this.startPolling();

    // Also observe DOM for play state changes
    this.observePlayState();

    // Check initial state - only register if playing
    const isPlaying = this.isCurrentlyPlaying();
    Logger.debug('SoundCloud: Initial state - playing:', isPlaying);

    if (isPlaying) {
      this.handlePlayStart();
    }
    // If not playing, we DON'T register - wait until user plays
  }

  registerIfNeeded() {
    if (!this.registered) {
      const info = this.getMediaInfo(null, this.currentMediaId);
      this.mediaElements.set(this.currentMediaId, { element: null, info });
      this.sendMessage(AUTOSTOP.MSG.MEDIA_REGISTERED, info);
      this.registered = true;
      Logger.success('SoundCloud: Registered');
    }
  }

  startPolling() {
    let lastState = this.isCurrentlyPlaying();
    let lastTimeUpdate = 0;

    this.pollInterval = setInterval(() => {
      const currentState = this.isCurrentlyPlaying();

      if (currentState !== lastState) {
        Logger.debug('SoundCloud: State changed', lastState, '→', currentState);
        if (currentState) {
          this.handlePlayStart();
        } else {
          this.handlePlayStop();
        }
        lastState = currentState;
      }

      // Update info periodically if registered
      if (this.registered && this.currentMediaId) {
        const stored = this.mediaElements.get(this.currentMediaId);
        if (stored) {
          stored.info = this.getMediaInfo(null, this.currentMediaId);
        }

        // Send time updates when playing (every ~500ms)
        const now = Date.now();
        if (this.isPlaying && now - lastTimeUpdate > 500) {
          lastTimeUpdate = now;
          this.sendTimeUpdate(
            this.currentMediaId,
            this.getCurrentTime(),
            this.getDuration(),
            1 // SoundCloud doesn't expose playback rate
          );
        }
      }
    }, 300); // Poll every 300ms
  }

  observePlayState() {
    // Observe the play button for class changes
    const observer = new MutationObserver((mutations) => {
      const isPlaying = this.isCurrentlyPlaying();

      if (isPlaying && !this.isPlaying) {
        this.handlePlayStart();
      } else if (!isPlaying && this.isPlaying) {
        this.handlePlayStop();
      }
    });

    // Observe play button and playback controls
    const targets = [
      this.getPlayButton(),
      document.querySelector('.playControls'),
      document.querySelector('.playControl')
    ].filter(Boolean);

    for (const target of targets) {
      observer.observe(target, {
        attributes: true,
        attributeFilter: ['class', 'aria-label', 'title']
      });
    }
  }

  handlePlayStart() {
    Logger.media('SoundCloud: Play started', this.getTitle(null));
    this.isPlaying = true;
    this.registerIfNeeded();
    this.clearPausedFlag(this.currentMediaId);

    const info = this.getMediaInfo(null, this.currentMediaId);
    info.isPlaying = true;
    this.sendMessage(AUTOSTOP.MSG.MEDIA_PLAY, info);
  }

  handlePlayStop() {
    Logger.media('SoundCloud: Play stopped', this.getTitle(null));
    const wasManual = !this.wasPausedByExtension(this.currentMediaId);
    this.isPlaying = false;

    // Only send pause if we were registered
    if (this.registered) {
      this.sendMessage(AUTOSTOP.MSG.MEDIA_PAUSE, {
        mediaId: this.currentMediaId,
        currentTime: this.getCurrentTime(),
        manual: wasManual
      });
    }
  }

  // ===== SoundCloud DOM Selectors =====

  getPlayButton() {
    // Main play/pause button in the player bar at the bottom
    return document.querySelector('.playControl') ||
           document.querySelector('.playControls__play') ||
           document.querySelector('button.playControl');
  }

  getNextButton() {
    return document.querySelector('.playControls__next') ||
           document.querySelector('.skipControl__next') ||
           document.querySelector('button[aria-label*="Next" i]');
  }

  getPrevButton() {
    return document.querySelector('.playControls__prev') ||
           document.querySelector('.skipControl__previous');
  }

  isCurrentlyPlaying() {
    const playBtn = this.getPlayButton();

    if (!playBtn) {
      return false;
    }

    // Method 1: Check for 'playing' class on the button
    if (playBtn.classList.contains('playing')) {
      return true;
    }

    // Method 2: Check aria-label - if it says "Pause", media is playing
    const ariaLabel = (playBtn.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('pause') && !ariaLabel.includes('play')) {
      return true;
    }

    // Method 3: Check title attribute
    const title = (playBtn.getAttribute('title') || '').toLowerCase();
    if (title.includes('pause') && !title.includes('play')) {
      return true;
    }

    // Method 4: Check the parent container for playing state
    const playControls = document.querySelector('.playControls');
    if (playControls?.classList.contains('m-playing')) {
      return true;
    }

    // Method 5: Check if there's a pause icon visible inside the button
    const pauseIcon = playBtn.querySelector('.sc-button-pause') ||
                      playBtn.querySelector('[class*="pause"]');
    if (pauseIcon) {
      return true;
    }

    return false;
  }

  getCurrentTime() {
    const timeEl = document.querySelector('.playbackTimeline__timePassed span:last-child') ||
                   document.querySelector('.playbackTimeline__timePassed');
    if (timeEl) {
      return this.parseTime(timeEl.textContent);
    }
    return 0;
  }

  getDuration() {
    const durationEl = document.querySelector('.playbackTimeline__duration span:last-child') ||
                       document.querySelector('.playbackTimeline__duration');
    if (durationEl) {
      return this.parseTime(durationEl.textContent);
    }
    return 0;
  }

  parseTime(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
  }

  // ===== Overrides =====

  getTitle(element) {
    // SoundCloud specific selectors
    const selectors = [
      '.playbackSoundBadge__titleLink',
      '.playbackSoundBadge__title span[aria-hidden="true"]',
      '.playbackSoundBadge__titleContextContainer a',
      '.soundTitle__title span',
      '.fullHero__title'
    ];

    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 0) {
          return text.substring(0, 100);
        }
      } catch (e) {}
    }

    // Try to get artist - title format
    const artist = document.querySelector('.playbackSoundBadge__lightLink')?.textContent?.trim();
    const title = document.querySelector('.playbackSoundBadge__titleLink')?.textContent?.trim();
    if (artist && title) {
      return `${artist} - ${title}`.substring(0, 100);
    }

    return super.getTitle(element);
  }

  getCover(element) {
    // SoundCloud specific selectors for the player artwork
    const selectors = [
      '.playbackSoundBadge__avatar .sc-artwork span[style*="background"]',
      '.playbackSoundBadge__avatar span[style*="background"]',
      '.sc-artwork span[style*="background-image"]',
      '.image__full[style*="background"]'
    ];

    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const style = el.getAttribute('style') || '';
          const match = style.match(/background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/i);
          if (match) {
            return match[1];
          }

          const computed = window.getComputedStyle(el).backgroundImage;
          const computedMatch = computed?.match(/url\(['"]?([^'")\s]+)['"]?\)/);
          if (computedMatch) {
            return computedMatch[1];
          }
        }
      } catch (e) {}
    }

    return super.getCover(element);
  }

  getMediaInfo(element, mediaId) {
    return {
      mediaId,
      adapter: this.name,
      title: this.getTitle(element),
      cover: this.getCover(element),
      duration: this.getDuration(),
      currentTime: this.getCurrentTime(),
      isPlaying: this.isPlaying, // Use our tracked state
      hasSkip: !!this.getNextButton(),
      mediaType: 'audio'
    };
  }

  hasSkipButton() {
    return !!this.getNextButton();
  }

  // ===== Controls =====

  play(mediaId) {
    Logger.debug('SoundCloud: Play command');
    const playBtn = this.getPlayButton();
    if (playBtn && !this.isCurrentlyPlaying()) {
      playBtn.click();
    }
  }

  pause(mediaId) {
    Logger.debug('SoundCloud: Pause command');
    this.pausedByExtension.add(mediaId);
    const playBtn = this.getPlayButton();
    if (playBtn && this.isCurrentlyPlaying()) {
      playBtn.click();
    }
  }

  setVolume(mediaId, volume) {
    const clampedVolume = Math.max(0, Math.min(1, volume));
    Logger.debug('SoundCloud: Set volume to', (clampedVolume * 100).toFixed(0) + '%');

    // Method 1: Try to set via the volume slider
    const sliderSelectors = [
      '.volume__sliderWrapper input[type="range"]',
      '.playControls__volume input[type="range"]',
      '.volume input[type="range"]',
      'input.volume__slider',
      '[class*="volume"] input[type="range"]'
    ];

    let sliderFound = false;
    for (const selector of sliderSelectors) {
      const volumeSlider = document.querySelector(selector);
      if (volumeSlider) {
        // Set value using native setter to bypass any framework issues
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(volumeSlider, clampedVolume * 100);

        // Dispatch events
        volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
        volumeSlider.dispatchEvent(new Event('change', { bubbles: true }));
        Logger.debug('SoundCloud: Volume slider found and set');
        sliderFound = true;
        break;
      }
    }

    if (!sliderFound) {
      Logger.warn('SoundCloud: Volume slider not found');
    }

    // Method 2: Also set volume directly on any audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(el => {
      el.volume = clampedVolume;
    });
    if (audioElements.length > 0) {
      Logger.debug('SoundCloud: Set volume on', audioElements.length, 'audio element(s)');
    }
  }

  skip(mediaId) {
    Logger.debug('SoundCloud: Skip command');
    const nextBtn = this.getNextButton();
    if (nextBtn) {
      nextBtn.click();
    }
  }
}

// Make available globally
window.SoundCloudAdapter = SoundCloudAdapter;
