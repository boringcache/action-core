jest.mock('@actions/core', () => ({
  notice: jest.fn(),
}));

describe('auth token helpers', () => {
  const envKeys = [
    'BORINGCACHE_RESTORE_TOKEN',
    'BORINGCACHE_SAVE_TOKEN',
    'BORINGCACHE_API_TOKEN',
  ] as const;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it('prefers restore token over save and api tokens', () => {
    process.env.BORINGCACHE_RESTORE_TOKEN = 'restore-token';
    process.env.BORINGCACHE_SAVE_TOKEN = 'save-token';
    process.env.BORINGCACHE_API_TOKEN = 'api-token';

    const { getAuthTokens, hasRestoreToken, hasSaveToken } = require('../lib/auth');
    expect(getAuthTokens()).toEqual({
      restoreToken: 'restore-token',
      saveToken: 'save-token',
      apiToken: 'api-token',
    });
    expect(hasRestoreToken()).toBe(true);
    expect(hasSaveToken()).toBe(true);
  });

  it('falls back from save token for restore operations', () => {
    process.env.BORINGCACHE_SAVE_TOKEN = 'save-token';

    const { getAuthTokens, hasRestoreToken, hasSaveToken } = require('../lib/auth');
    expect(getAuthTokens()).toEqual({
      restoreToken: 'save-token',
      saveToken: 'save-token',
      apiToken: undefined,
    });
    expect(hasRestoreToken()).toBe(true);
    expect(hasSaveToken()).toBe(true);
  });

  it('uses legacy api token for restore and save when split tokens are absent', () => {
    process.env.BORINGCACHE_API_TOKEN = 'api-token';

    const { getAuthTokens, hasRestoreToken, hasSaveToken } = require('../lib/auth');
    expect(getAuthTokens()).toEqual({
      restoreToken: 'api-token',
      saveToken: 'api-token',
      apiToken: 'api-token',
    });
    expect(hasRestoreToken()).toBe(true);
    expect(hasSaveToken()).toBe(true);
  });

  it('reports no capabilities when no auth envs are configured', () => {
    const { getAuthTokens, hasRestoreToken, hasSaveToken } = require('../lib/auth');
    expect(getAuthTokens()).toEqual({
      restoreToken: undefined,
      saveToken: undefined,
      apiToken: undefined,
    });
    expect(hasRestoreToken()).toBe(false);
    expect(hasSaveToken()).toBe(false);
  });

  it('detects when only the legacy api token is configured', () => {
    process.env.BORINGCACHE_API_TOKEN = 'api-token';

    const { isUsingLegacyApiTokenOnly } = require('../lib/auth');
    expect(isUsingLegacyApiTokenOnly()).toBe(true);
  });

  it('warns once when relying on the legacy api token fallback', () => {
    process.env.BORINGCACHE_API_TOKEN = 'api-token';

    const core = require('@actions/core');
    const { warnIfUsingLegacyApiToken } = require('../lib/auth');

    warnIfUsingLegacyApiToken();
    warnIfUsingLegacyApiToken();

    expect(core.notice).toHaveBeenCalledTimes(1);
    expect(core.notice).toHaveBeenCalledWith(
      'Using BORINGCACHE_API_TOKEN as a legacy compatibility fallback. Prefer BORINGCACHE_RESTORE_TOKEN and BORINGCACHE_SAVE_TOKEN for new workflows.'
    );
  });

  it('does not warn when split tokens are configured', () => {
    process.env.BORINGCACHE_RESTORE_TOKEN = 'restore-token';
    process.env.BORINGCACHE_SAVE_TOKEN = 'save-token';
    process.env.BORINGCACHE_API_TOKEN = 'api-token';

    const core = require('@actions/core');
    const { warnIfUsingLegacyApiToken } = require('../lib/auth');

    warnIfUsingLegacyApiToken();

    expect(core.notice).not.toHaveBeenCalled();
  });
});
