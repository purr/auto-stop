// Auto-Stop Media - Adapter Registry
// Manages loading the appropriate adapter for each site

class AdapterRegistry {
  constructor() {
    this.adapters = [];
    this.activeAdapter = null;
  }

  /**
   * Register an adapter class
   * @param {typeof BaseAdapter} AdapterClass
   */
  register(AdapterClass) {
    this.adapters.push(AdapterClass);
    // Sort by priority (highest first)
    this.adapters.sort((a, b) => {
      const priorityA = new a().priority;
      const priorityB = new b().priority;
      return priorityB - priorityA;
    });
  }

  /**
   * Get the best matching adapter for the current page
   * @returns {BaseAdapter}
   */
  getAdapter() {
    if (this.activeAdapter) {
      return this.activeAdapter;
    }

    for (const AdapterClass of this.adapters) {
      const adapter = new AdapterClass();
      if (adapter.matches()) {
        Logger.info(`Using ${adapter.name} adapter`);
        this.activeAdapter = adapter;
        return adapter;
      }
    }

    // Fallback to generic (should always match)
    Logger.info('No specific adapter found, using generic');
    this.activeAdapter = new GenericAdapter();
    return this.activeAdapter;
  }

  /**
   * Initialize the appropriate adapter
   */
  init() {
    const adapter = this.getAdapter();
    adapter.init();
    return adapter;
  }
}

// Create global registry instance
window.adapterRegistry = new AdapterRegistry();

// Register all adapters (order doesn't matter due to priority sorting)
// Only register site-specific adapters for sites that need special handling
// YouTube, Spotify, etc. work fine with the generic adapter
window.adapterRegistry.register(SoundCloudAdapter);
window.adapterRegistry.register(GenericAdapter);

Logger.debug('Adapter registry initialized with', window.adapterRegistry.adapters.length, 'adapters');

