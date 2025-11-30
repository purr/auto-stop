// Auto-Stop Media - Storage Manager
// Handles persistent settings storage

class StorageManager {
  constructor() {
    this.settings = { ...AUTOSTOP.DEFAULT_SETTINGS };
    this.loaded = false;
  }

  /**
   * Load settings from storage
   */
  async load() {
    try {
      const stored = await browser.storage.local.get(['settings']);
      if (stored.settings) {
        this.settings = { ...AUTOSTOP.DEFAULT_SETTINGS, ...stored.settings };
      }
      this.loaded = true;
      Logger.success('Settings loaded:', this.settings);
    } catch (e) {
      Logger.error('Failed to load settings:', e);
    }
    return this.settings;
  }

  /**
   * Save settings to storage
   */
  async save() {
    try {
      await browser.storage.local.set({ settings: this.settings });
      Logger.debug('Settings saved');
    } catch (e) {
      Logger.error('Failed to save settings:', e);
    }
  }

  /**
   * Update settings
   * @param {Object} updates
   */
  async update(updates) {
    this.settings = { ...this.settings, ...updates };
    await this.save();
    return this.settings;
  }

  /**
   * Get current settings
   */
  get() {
    return this.settings;
  }

  /**
   * Check if a URL is whitelisted
   * Supports wildcards: *.example.com matches sub.example.com
   * @param {string} url
   */
  isWhitelisted(url) {
    if (!url) return false;
    try {
      const hostname = new URL(url).hostname;
      return this.settings.whitelist.some(pattern => {
        // Wildcard pattern: *.example.com
        if (pattern.startsWith('*.')) {
          const baseDomain = pattern.slice(2); // Remove "*."
          return hostname === baseDomain || hostname.endsWith('.' + baseDomain);
        }
        // Exact match or subdomain match
        return hostname === pattern || hostname.endsWith('.' + pattern);
      });
    } catch {
      return false;
    }
  }
}

// Make available globally
window.storageManager = new StorageManager();

