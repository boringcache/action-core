import { getInputsWorkspace } from '../lib/inputs';
import { getWorkspace } from '../lib/workspace';

describe('workspace helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BORINGCACHE_DEFAULT_WORKSPACE;
    delete process.env.GITHUB_REPOSITORY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses BORINGCACHE_DEFAULT_WORKSPACE for input-based resolution', () => {
    process.env.BORINGCACHE_DEFAULT_WORKSPACE = 'boringcache/web';
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    expect(getInputsWorkspace({})).toBe('boringcache/web');
  });

  it('normalizes BORINGCACHE_DEFAULT_WORKSPACE without a namespace for input-based resolution', () => {
    process.env.BORINGCACHE_DEFAULT_WORKSPACE = 'web';

    expect(getInputsWorkspace({})).toBe('default/web');
  });

  it('uses BORINGCACHE_DEFAULT_WORKSPACE for direct workspace resolution', () => {
    process.env.BORINGCACHE_DEFAULT_WORKSPACE = 'boringcache/web';

    expect(getWorkspace('')).toBe('boringcache/web');
  });

  it('does not fall back to GITHUB_REPOSITORY for input-based resolution', () => {
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    expect(getInputsWorkspace({})).toBe('default/default');
  });
});
