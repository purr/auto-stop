// Auto-Stop Media - Popup Script

class PopupController {
  constructor() {
    this.state = {
      activeMedia: null,
      pausedStack: [],
      allMedia: [],
      settings: {
        useMute: false,
        whitelist: []
      }
    };

    // Track previous state to avoid unnecessary re-renders
    this.prevPausedStackIds = [];
    this.prevPausedStackState = '';

    this.init();
  }

  async init() {
    // Get initial state from background
    await this.fetchState();

    // Set up event listeners
    this.setupEventListeners();

    // Render UI
    this.render();

    // Listen for state updates from background (includes real-time progress)
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'STATE_UPDATE') {
        this.state = message.data;
        this.render();
      }
    });

    // Backup poll in case messages are missed
    setInterval(() => this.fetchState(), 2000);
  }

  async fetchState() {
    try {
      const state = await browser.runtime.sendMessage({ type: 'GET_STATE' });
      if (state) {
        this.state = state;
        this.render();
      }
    } catch (e) {
      console.log('Failed to fetch state:', e);
    }
  }

  setupEventListeners() {
    // Settings toggle
    document.getElementById('settingsBtn').addEventListener('click', () => {
      const panel = document.getElementById('settingsPanel');
      const btn = document.getElementById('settingsBtn');
      const isOpening = !panel.classList.contains('visible');

      panel.classList.toggle('visible');
      btn.classList.toggle('active');

      // Collapse whitelist when closing settings
      if (!isOpening) {
        this.collapseWhitelist();
      }
    });

    // Mode toggle (pause/mute)
    document.querySelectorAll('#modeToggle .pill-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const useMute = btn.dataset.value === 'mute';
        this.updateSettings({ useMute });

        // Update UI
        document.querySelectorAll('#modeToggle .pill-option').forEach(b => {
          b.classList.toggle('active', b.dataset.value === btn.dataset.value);
        });
      });
    });

    // Whitelist expand/collapse
    document.getElementById('whitelistExpandHeader').addEventListener('click', () => {
      this.toggleWhitelist();
    });

    // Add whitelist
    document.getElementById('addWhitelistBtn').addEventListener('click', () => {
      this.addWhitelistDomain();
    });

    document.getElementById('whitelistInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.addWhitelistDomain();
      }
    });

    // Active media controls - these are handled dynamically in renderActiveMedia
    document.getElementById('activeSkipBtn').addEventListener('click', () => {
      if (this.state.activeMedia) {
        this.controlMedia(this.state.activeMedia, 'skip');
      }
    });

    // Resume behavior settings (number inputs)
    const settingsInputs = ['resumeDelay', 'fadeInDuration', 'fadeInStartVolume', 'autoExpireSeconds'];
    settingsInputs.forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('change', () => {
          let value = parseInt(input.value, 10) || 0;

          // Convert percentage to decimal for fadeInStartVolume
          if (id === 'fadeInStartVolume') {
            value = Math.max(0, Math.min(100, value)) / 100;
          }

          this.updateSettings({ [id]: value });
        });
      }
    });

    // Resume on manual pause checkbox
    const resumeOnManualPauseCheckbox = document.getElementById('resumeOnManualPause');
    if (resumeOnManualPauseCheckbox) {
      resumeOnManualPauseCheckbox.addEventListener('change', () => {
        this.updateSettings({ resumeOnManualPause: resumeOnManualPauseCheckbox.checked });
      });
    }
  }

  async updateSettings(updates) {
    try {
      const newSettings = await browser.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        data: updates
      });
      this.state.settings = newSettings;
      this.render();
    } catch (e) {
      console.log('Failed to update settings:', e);
    }
  }

  addWhitelistDomain() {
    const input = document.getElementById('whitelistInput');
    let domain = input.value.trim().toLowerCase();

    if (!domain) return;

    // Clean up domain
    domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');

    if (!domain || this.state.settings.whitelist.includes(domain)) {
      input.value = '';
      return;
    }

    const newWhitelist = [...this.state.settings.whitelist, domain];
    this.updateSettings({ whitelist: newWhitelist });
    input.value = '';
  }

  removeWhitelistDomain(domain) {
    const newWhitelist = this.state.settings.whitelist.filter(d => d !== domain);
    this.updateSettings({ whitelist: newWhitelist });
  }

  toggleWhitelist() {
    const header = document.getElementById('whitelistExpandHeader');
    const content = document.getElementById('whitelistExpandContent');
    header.classList.toggle('expanded');
    content.classList.toggle('expanded');
  }

  collapseWhitelist() {
    const header = document.getElementById('whitelistExpandHeader');
    const content = document.getElementById('whitelistExpandContent');
    header.classList.remove('expanded');
    content.classList.remove('expanded');
  }

  async controlMedia(media, action) {
    try {
      await browser.runtime.sendMessage({
        type: 'CONTROL_MEDIA',
        data: {
          tabId: media.tabId,
          frameId: media.frameId,
          mediaId: media.mediaId,
          action
        }
      });
      // Refresh state after control action
      setTimeout(() => this.fetchState(), 200);
    } catch (e) {
      console.log('Failed to control media:', e);
    }
  }

  formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getSourceName(url) {
    if (!url) return 'Unknown';
    try {
      const hostname = new URL(url).hostname;
      return hostname.replace(/^www\./, '');
    } catch {
      return 'Unknown';
    }
  }

  render() {
    this.renderSettings();
    this.renderActiveMedia();
    this.renderPausedStack();
  }

  renderSettings() {
    const { settings } = this.state;

    // Mode toggle
    document.querySelectorAll('#modeToggle .pill-option').forEach(btn => {
      const isActive = (btn.dataset.value === 'mute') === settings.useMute;
      btn.classList.toggle('active', isActive);
    });

    // Mode hint
    const modeHint = document.getElementById('modeHint');
    if (modeHint) {
      modeHint.textContent = settings.useMute
        ? '🔇 Mutes the entire tab (like right-click → Mute Tab)'
        : '⏸️ Pauses the media element directly';
    }

    // Resume behavior settings (only update if not focused to avoid overwriting user input)
    const resumeDelayInput = document.getElementById('resumeDelay');
    if (resumeDelayInput && document.activeElement !== resumeDelayInput) {
      resumeDelayInput.value = settings.resumeDelay ?? 1500;
    }

    const fadeInDurationInput = document.getElementById('fadeInDuration');
    if (fadeInDurationInput && document.activeElement !== fadeInDurationInput) {
      fadeInDurationInput.value = settings.fadeInDuration ?? 2000;
    }

    const fadeInStartVolumeInput = document.getElementById('fadeInStartVolume');
    if (fadeInStartVolumeInput && document.activeElement !== fadeInStartVolumeInput) {
      fadeInStartVolumeInput.value = Math.round((settings.fadeInStartVolume ?? 0.2) * 100);
    }

    const autoExpireInput = document.getElementById('autoExpireSeconds');
    if (autoExpireInput && document.activeElement !== autoExpireInput) {
      autoExpireInput.value = settings.autoExpireSeconds ?? 0;
    }

    // Resume on manual pause checkbox
    const resumeOnManualPauseCheckbox = document.getElementById('resumeOnManualPause');
    if (resumeOnManualPauseCheckbox) {
      resumeOnManualPauseCheckbox.checked = settings.resumeOnManualPause ?? true;
    }

    // Whitelist count
    const whitelistCount = document.getElementById('whitelistCount');
    whitelistCount.textContent = settings.whitelist.length;

    // Whitelist items
    const whitelistContainer = document.getElementById('whitelistItems');
    whitelistContainer.innerHTML = settings.whitelist.length === 0
      ? '<li class="whitelist-empty">No domains added</li>'
      : settings.whitelist.map(domain => `
        <li class="whitelist-item">
          <span class="domain-name" title="${this.escapeHtml(domain)}">${this.escapeHtml(domain)}</span>
          <button class="remove-btn" data-domain="${this.escapeHtml(domain)}" title="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </li>
      `).join('');

    // Add remove handlers
    whitelistContainer.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeWhitelistDomain(btn.dataset.domain);
      });
    });
  }

  renderActiveMedia() {
    const { activeMedia, allMedia, pendingResume } = this.state;
    const card = document.getElementById('activeMediaCard');
    const emptyState = document.getElementById('emptyNowPlaying');
    const sectionDot = document.getElementById('nowPlayingDot');
    const sectionLabel = document.getElementById('nowPlayingLabel');

    // Determine what to show: active media OR pending resume media
    const displayMedia = activeMedia || (pendingResume?.media);
    const isPending = !activeMedia && pendingResume?.media;
    const isFadingIn = pendingResume?.isFadingIn;

    if (!displayMedia) {
      card.classList.add('hidden');
      emptyState.classList.remove('hidden');
      sectionDot.className = 'section-dot';
      sectionLabel.textContent = 'Now Playing';
      return;
    }

    card.classList.remove('hidden');
    emptyState.classList.add('hidden');

    // Update card and section header styling for pending state
    if (isPending) {
      card.classList.add('pending');
      card.classList.remove('active');
      sectionDot.className = 'section-dot pending';
      sectionLabel.textContent = isFadingIn ? 'Resuming...' : 'Waiting...';
    } else {
      card.classList.remove('pending');
      card.classList.add('active');
      sectionDot.className = 'section-dot active';
      sectionLabel.textContent = 'Now Playing';
    }

    // Find full media info
    const mediaInfo = allMedia.find(m =>
      m.tabId === displayMedia.tabId &&
      m.frameId === displayMedia.frameId &&
      m.mediaId === displayMedia.mediaId
    );

    // Determine if actually playing
    const isPlaying = isPending ? false : (mediaInfo?.isPlaying ?? true);

    // Cover
    const coverEl = document.getElementById('activeCover');
    if (displayMedia.cover) {
      coverEl.innerHTML = `<img src="${this.escapeHtml(displayMedia.cover)}" alt="Cover">`;
    } else {
      coverEl.innerHTML = `
        <svg class="cover-placeholder" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
        </svg>
      `;
    }

    // Type badge - show "RESUMING" or "FADING IN" when pending
    const typeBadge = document.getElementById('activeTypeBadge');
    if (isPending) {
      typeBadge.textContent = isFadingIn ? 'FADING IN' : 'RESUMING...';
      typeBadge.classList.add('pending-badge');
    } else {
      typeBadge.textContent = (mediaInfo?.mediaType || 'media').toUpperCase();
      typeBadge.classList.remove('pending-badge');
    }

    // Title
    document.getElementById('activeTitle').textContent = displayMedia.title || 'Unknown';

    // Source
    const favicon = document.getElementById('activeFavicon');
    if (displayMedia.favicon) {
      favicon.src = displayMedia.favicon;
      favicon.classList.add('visible');
    } else {
      favicon.classList.remove('visible');
    }
    document.getElementById('activeSource').textContent = this.getSourceName(displayMedia.url);

    // Progress - use actual time from background (updated every 500ms by content script)
    const currentTime = displayMedia.currentTime || 0;
    const duration = displayMedia.duration || 0;

    const progress = duration > 0
      ? Math.min((currentTime / duration) * 100, 100)
      : 0;
    document.getElementById('activeProgress').style.width = `${progress}%`;
    document.getElementById('activeCurrentTime').textContent = this.formatTime(currentTime);
    document.getElementById('activeDuration').textContent = this.formatTime(duration);

    // Play/Pause button - show pause icon if playing, play icon if paused
    const playPauseBtn = document.getElementById('activePlayPauseBtn');
    const pauseIcon = playPauseBtn.querySelector('.icon-pause');
    const playIcon = playPauseBtn.querySelector('.icon-play');

    if (isPlaying) {
      pauseIcon.classList.remove('hidden');
      playIcon.classList.add('hidden');
      playPauseBtn.title = 'Pause';
    } else {
      pauseIcon.classList.add('hidden');
      playIcon.classList.remove('hidden');
      playPauseBtn.title = 'Play';
    }

    // Update click handler - for pending media, always show play
    playPauseBtn.onclick = () => {
      if (isPending) {
        // For pending media, clicking play cancels the delay and plays immediately
        this.controlMedia(displayMedia, 'play');
      } else {
        this.controlMedia(displayMedia, isPlaying ? 'pause' : 'play');
      }
    };

    // Skip button - disabled for pending media
    const skipBtn = document.getElementById('activeSkipBtn');
    skipBtn.disabled = isPending || !(mediaInfo?.hasSkip);

    // Make the card clickable to focus the tab (but not when clicking controls)
    card.onclick = (e) => {
      // Don't trigger if clicking on buttons
      if (e.target.closest('button')) return;
      this.focusTab(displayMedia.tabId);
    };
    card.style.cursor = 'pointer';
  }

  renderPausedStack() {
    const { pausedStack } = this.state;
    const list = document.getElementById('pausedList');
    const emptyState = document.getElementById('emptyPaused');
    const countEl = document.getElementById('pausedCount');

    // Filter out "Unknown" media (both title and source are unknown)
    const filteredStack = pausedStack.filter(media => {
      const title = media.title || 'Unknown';
      const source = this.getSourceName(media.url);
      // Hide if both are "Unknown"
      return !(title === 'Unknown' && source === 'Unknown');
    });

    countEl.textContent = filteredStack.length;
    const wrapper = document.getElementById('pausedListWrapper');

    if (filteredStack.length === 0) {
      list.innerHTML = '';
      emptyState.classList.remove('hidden');
      wrapper.classList.add('hidden');
      wrapper.classList.remove('can-scroll-up', 'can-scroll-down');
      this.prevPausedStackIds = [];
      this.prevPausedStackState = '';
      return;
    }

    emptyState.classList.add('hidden');
    wrapper.classList.remove('hidden');

    // Check if the filtered stack has actually changed (including manuallyPaused flag)
    const currentState = filteredStack.map(m => `${m.mediaId}:${m.manuallyPaused}`).join(',');
    const prevState = this.prevPausedStackState || '';

    if (currentState === prevState) {
      // No change - don't re-render (this prevents the animation glitch)
      return;
    }

    // Update tracking
    this.prevPausedStackState = currentState;
    this.prevPausedStackIds = filteredStack.map(m => m.mediaId);

    // Paused stack items should show PLAY button (to resume)
    list.innerHTML = filteredStack.map(media => this.renderMediaListItem(media)).join('');

    // Add click handlers
    list.querySelectorAll('.media-list-item').forEach((item, index) => {
      const media = filteredStack[index];

      item.querySelector('.play-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.controlMedia(media, 'play');
      });

      item.addEventListener('click', () => {
        this.focusTab(media.tabId);
      });
    });

    // Update scroll shadows
    this.updateScrollShadows();
  }

  updateScrollShadows() {
    const wrapper = document.getElementById('pausedListWrapper');
    const list = document.getElementById('pausedList');

    if (!wrapper || !list) return;

    const updateShadows = () => {
      const canScrollUp = list.scrollTop > 0;
      const canScrollDown = list.scrollTop < (list.scrollHeight - list.clientHeight - 2);

      wrapper.classList.toggle('can-scroll-up', canScrollUp);
      wrapper.classList.toggle('can-scroll-down', canScrollDown);
    };

    // Initial check
    updateShadows();

    // Remove old listener and add new one
    list.removeEventListener('scroll', this._scrollHandler);
    this._scrollHandler = updateShadows;
    list.addEventListener('scroll', this._scrollHandler);
  }

  renderMediaListItem(media) {
    const coverHtml = media.cover
      ? `<img src="${this.escapeHtml(media.cover)}" alt="Cover">`
      : `<svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
         </svg>`;

    // Badge for manually paused (won't auto-resume)
    const manualBadge = media.manuallyPaused
      ? `<span class="manual-badge" title="Manually paused - won't auto-resume">⏸</span>`
      : '';

    return `
      <div class="media-list-item ${media.manuallyPaused ? 'manually-paused' : ''}" data-media-id="${this.escapeHtml(media.mediaId)}">
        <div class="status-dot ${media.manuallyPaused ? 'manual' : 'paused'}"></div>
        <div class="mini-cover">${coverHtml}</div>
        <div class="item-info">
          <div class="item-title">${this.escapeHtml(media.title || 'Unknown')}${manualBadge}</div>
          <div class="item-source">
            ${media.favicon ? `<img src="${this.escapeHtml(media.favicon)}" alt="">` : ''}
            <span>${this.getSourceName(media.url)}</span>
          </div>
        </div>
        <button class="play-btn" title="${media.manuallyPaused ? 'Resume (clears manual pause)' : 'Resume'}">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
        </button>
      </div>
    `;
  }

  async focusTab(tabId) {
    try {
      await browser.tabs.update(tabId, { active: true });
      const tab = await browser.tabs.get(tabId);
      if (tab.windowId) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
    } catch (e) {
      console.log('Failed to focus tab:', e);
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
