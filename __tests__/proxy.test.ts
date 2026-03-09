import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProxyTags, waitForProxy } from '../lib/proxy';

describe('normalizeProxyTags', () => {
  it('keeps a single human tag unchanged', () => {
    expect(normalizeProxyTags('hugo-docker-build')).toBe('hugo-docker-build');
  });

  it('trims whitespace and preserves tag order', () => {
    expect(normalizeProxyTags('tag1, tag2 ,tag3')).toBe('tag1,tag2,tag3');
  });

  it('deduplicates repeated tags', () => {
    expect(normalizeProxyTags('tag1,tag2,tag1,tag2,tag3')).toBe('tag1,tag2,tag3');
  });

  it('rejects empty tag input', () => {
    expect(() => normalizeProxyTags(' , , ')).toThrow(
      'At least one proxy tag is required'
    );
  });
});

describe('waitForProxy log lookup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    for (const port of [5000, 7001]) {
      const logPath = path.join(os.tmpdir(), `boringcache-proxy-${port}.log`);
      try {
        fs.unlinkSync(logPath);
      } catch {
        // Ignore missing temp files from tests.
      }
    }
  });

  it('reads the per-port proxy log when the proxy exits before readiness', async () => {
    const logPath = path.join(os.tmpdir(), 'boringcache-proxy-5000.log');
    fs.writeFileSync(logPath, 'port-specific log');
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('not running');
    });

    await expect(waitForProxy(5000, 1000, 12345)).rejects.toThrow('port-specific log');
  });

  it('reads the per-port proxy log when readiness times out', async () => {
    const logPath = path.join(os.tmpdir(), 'boringcache-proxy-7001.log');
    fs.writeFileSync(logPath, 'timeout log');

    await expect(waitForProxy(7001, 0)).rejects.toThrow('timeout log');
  });
});
