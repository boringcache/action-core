export {
  ensureBoringCache,
  execBoringCache,
  isCliAvailable,
  getToolCacheInfo,
  SetupOptions,
  ToolCacheInfo,
} from './setup';

export {
  getWorkspace,
  getCacheTagPrefix,
  pathExists,
} from './workspace';

export {
  getCacheConfig,
  validateInputs,
  resolvePath,
  resolvePaths,
  parseEntries,
  getPlatformSuffix,
  getInputsWorkspace,
  convertCacheFormatToEntries,
  CacheConfig,
  CacheEntry,
} from './inputs';

export {
  startRegistryProxy,
  waitForProxy,
  stopRegistryProxy,
  findAvailablePort,
  ProxyOptions,
  ProxyHandle,
} from './proxy';
