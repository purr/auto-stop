// Auto-Stop Media - Popup Script
// Handles the extension popup UI: displays media state, settings, and controls

class PopupController {
  constructor() {
    this.state = {
      activeMedia: null,
      pausedStack: [],
      allMedia: [],
      settings: {
        Blacklist: []
      }
    };

    // Track previous state to avoid unnecessary re-renders
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

      // Collapse Blacklist when closing settings
      if (!isOpening) {
        this.collapseBlacklist();
      }
    });

    // Blacklist expand/collapse
    document.getElementById('BlacklistExpandHeader').addEventListener('click', () => {
      this.toggleBlacklist();
    });

    // Add Blacklist
    document.getElementById('addBlacklistBtn').addEventListener('click', () => {
      this.addBlacklistDomain();
    });

    document.getElementById('BlacklistInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.addBlacklistDomain();
      }
    });

    // Active media controls - these are handled dynamically in renderActiveMedia
    document.getElementById('activeSkipBtn').addEventListener('click', () => {
      if (this.state.activeMedia) {
        this.controlMedia(this.state.activeMedia, 'skip');
      }
    });

    document.getElementById('activePrevBtn').addEventListener('click', () => {
      if (this.state.activeMedia) {
        this.controlMedia(this.state.activeMedia, 'prev');
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

          // Clamp autoExpireSeconds to 0-1000
          if (id === 'autoExpireSeconds') {
            value = Math.max(0, Math.min(1000, value));
            input.value = value; // Update display
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

  addBlacklistDomain() {
    const input = document.getElementById('BlacklistInput');
    let domain = input.value.trim().toLowerCase();

    if (!domain) return;

    // Clean up domain
    domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');

    if (!domain || this.state.settings.Blacklist.includes(domain)) {
      input.value = '';
      return;
    }

    const newBlacklist = [...this.state.settings.Blacklist, domain];
    this.updateSettings({ Blacklist: newBlacklist });
    input.value = '';
  }

  removeBlacklistDomain(domain) {
    const newBlacklist = this.state.settings.Blacklist.filter(d => d !== domain);
    this.updateSettings({ Blacklist: newBlacklist });
  }

  toggleBlacklist() {
    const header = document.getElementById('BlacklistExpandHeader');
    const content = document.getElementById('BlacklistExpandContent');
    header.classList.toggle('expanded');
    content.classList.toggle('expanded');
  }

  collapseBlacklist() {
    const header = document.getElementById('BlacklistExpandHeader');
    const content = document.getElementById('BlacklistExpandContent');
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

    // Blacklist count
    const BlacklistCount = document.getElementById('BlacklistCount');
    BlacklistCount.textContent = settings.Blacklist.length;

    // Blacklist items - use DOM manipulation instead of innerHTML
    const BlacklistContainer = document.getElementById('BlacklistItems');
    BlacklistContainer.textContent = '';

    if (settings.Blacklist.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'Blacklist-empty';
      emptyLi.textContent = 'No domains added';
      BlacklistContainer.appendChild(emptyLi);
    } else {
      settings.Blacklist.forEach(domain => {
        const li = document.createElement('li');
        li.className = 'Blacklist-item';

        const span = document.createElement('span');
        span.className = 'domain-name';
        span.title = domain;
        span.textContent = domain;

        const btn = document.createElement('button');
        btn.className = 'remove-btn';
        btn.title = 'Remove';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeBlacklistDomain(domain);
        });

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', '18'); line1.setAttribute('y1', '6');
        line1.setAttribute('x2', '6'); line1.setAttribute('y2', '18');
        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', '6'); line2.setAttribute('y1', '6');
        line2.setAttribute('x2', '18'); line2.setAttribute('y2', '18');
        svg.appendChild(line1);
        svg.appendChild(line2);
        btn.appendChild(svg);

        li.appendChild(span);
        li.appendChild(btn);
        BlacklistContainer.appendChild(li);
      });
    }
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

    // Cover (using DOM manipulation to avoid innerHTML security warnings)
    const coverEl = document.getElementById('activeCover');
    coverEl.textContent = '';
    if (displayMedia.cover) {
      const img = document.createElement('img');
      img.src = displayMedia.cover;
      img.alt = 'Cover';
      coverEl.appendChild(img);
    } else {
      coverEl.appendChild(this.createMusicNoteSvg('cover-placeholder'));
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

    // Skip and Prev buttons - only disabled for pending media
    const skipBtn = document.getElementById('activeSkipBtn');
    const prevBtn = document.getElementById('activePrevBtn');
    skipBtn.disabled = isPending;
    prevBtn.disabled = isPending;

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
      list.textContent = '';
      emptyState.classList.remove('hidden');
      wrapper.classList.add('hidden');
      wrapper.classList.remove('can-scroll-up', 'can-scroll-down');
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

    // Paused stack items - use DOM manipulation instead of innerHTML
    list.textContent = '';
    filteredStack.forEach(media => {
      const item = this.createMediaListItem(media);
      list.appendChild(item);
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

  createMediaListItem(media) {
    const item = document.createElement('div');
    item.className = `media-list-item ${media.manuallyPaused ? 'manually-paused' : ''}`;
    item.dataset.mediaId = media.mediaId;

    // Status dot
    const statusDot = document.createElement('div');
    statusDot.className = `status-dot ${media.manuallyPaused ? 'manual' : 'paused'}`;
    item.appendChild(statusDot);

    // Mini cover
    const miniCover = document.createElement('div');
    miniCover.className = 'mini-cover';
    if (media.cover) {
      const img = document.createElement('img');
      img.src = media.cover;
      img.alt = 'Cover';
      miniCover.appendChild(img);
    } else {
      miniCover.appendChild(this.createMusicNoteSvg());
    }
    item.appendChild(miniCover);

    // Item info
    const itemInfo = document.createElement('div');
    itemInfo.className = 'item-info';

    const itemTitle = document.createElement('div');
    itemTitle.className = 'item-title';
    itemTitle.textContent = media.title || 'Unknown';
    if (media.manuallyPaused) {
      const badge = document.createElement('span');
      badge.className = 'manual-badge';
      badge.title = "Manually paused - won't auto-resume";
      badge.textContent = '⏸';
      itemTitle.appendChild(badge);
    }
    itemInfo.appendChild(itemTitle);

    const itemSource = document.createElement('div');
    itemSource.className = 'item-source';
    if (media.favicon) {
      const favicon = document.createElement('img');
      favicon.src = media.favicon;
      favicon.alt = '';
      itemSource.appendChild(favicon);
    }
    const sourceSpan = document.createElement('span');
    sourceSpan.textContent = this.getSourceName(media.url);
    itemSource.appendChild(sourceSpan);
    itemInfo.appendChild(itemSource);

    item.appendChild(itemInfo);

    // Play button
    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.title = media.manuallyPaused ? 'Resume (clears manual pause)' : 'Resume';
    const playSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    playSvg.setAttribute('viewBox', '0 0 24 24');
    playSvg.setAttribute('fill', 'currentColor');
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '5,3 19,12 5,21');
    playSvg.appendChild(polygon);
    playBtn.appendChild(playSvg);
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.controlMedia(media, 'play');
    });
    item.appendChild(playBtn);

    // Click to focus tab
    item.addEventListener('click', () => {
      this.focusTab(media.tabId);
    });

    return item;
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

  /**
   * Create a music note SVG element (placeholder for missing cover art)
   * @param {string} className - Optional CSS class to add
   * @returns {SVGElement}
   */
  createMusicNoteSvg(className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (className) svg.classList.add(className);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z');
    svg.appendChild(path);
    return svg;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
