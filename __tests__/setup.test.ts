import * as os from 'os';
import * as crypto from 'crypto';

// Mock the modules before importing
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/tool-cache');
jest.mock('@actions/cache');

// Create a predictable "binary" content and its hash
const MOCK_BINARY_CONTENT = Buffer.from('mock-binary-content');
const MOCK_BINARY_HASH = crypto.createHash('sha256').update(MOCK_BINARY_CONTENT).digest('hex');

// Sample SHA256SUMS content using the mock binary hash
const SAMPLE_SHA256SUMS = `${MOCK_BINARY_HASH}  boringcache-linux-amd64
${MOCK_BINARY_HASH}  boringcache-linux-arm64
${MOCK_BINARY_HASH}  boringcache-macos-14-arm64
${MOCK_BINARY_HASH}  boringcache-windows-2022-amd64.exe
`;

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn(),
  },
}));

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as cache from '@actions/cache';
import * as fs from 'fs';
import { ensureBoringCache, execBoringCache, isCliAvailable, getToolCacheInfo } from '../lib/setup';

const mockedCore = jest.mocked(core);
const mockedExec = jest.mocked(exec);
const mockedTc = jest.mocked(tc);
const mockedCache = jest.mocked(cache);
const mockedFs = jest.mocked(fs);

describe('action-core', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RUNNER_OS;
    delete process.env.RUNNER_ARCH;
    delete process.env.BORINGCACHE_API_TOKEN;
    delete process.env.RUNNER_TOOL_CACHE;
    // Default cache mocks
    mockedCache.restoreCache.mockResolvedValue(undefined);
    mockedCache.saveCache.mockResolvedValue(1);
    // Mock fs.readFile to return appropriate content based on path
    mockedFs.promises.readFile.mockImplementation((path: any, encoding?: any) => {
      // If reading the checksums file (string encoding)
      if (encoding === 'utf-8' || typeof path === 'string' && path.includes('SHA256SUMS')) {
        return Promise.resolve(SAMPLE_SHA256SUMS);
      }
      // Otherwise return binary content (for hash computation)
      return Promise.resolve(MOCK_BINARY_CONTENT);
    });
  });

  describe('isCliAvailable', () => {
    it('returns true when CLI is available', async () => {
      mockedExec.exec.mockImplementation(async (cmd, args, options) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from('boringcache v1.7.0'));
        }
        return 0;
      });

      const result = await isCliAvailable();
      expect(result).toBe(true);
    });

    it('returns false when CLI is not available', async () => {
      mockedExec.exec.mockRejectedValue(new Error('Command not found'));

      const result = await isCliAvailable();
      expect(result).toBe(false);
    });

    it('returns false when CLI returns non-zero exit code', async () => {
      mockedExec.exec.mockResolvedValue(1);

      const result = await isCliAvailable();
      expect(result).toBe(false);
    });
  });

  describe('ensureBoringCache', () => {
    it('skips setup when version is "skip" and CLI is available', async () => {
      mockedExec.exec.mockImplementation(async (cmd, args, options) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from('boringcache v1.7.0'));
        }
        return 0;
      });

      await ensureBoringCache({ version: 'skip' });

      expect(mockedCore.debug).toHaveBeenCalledWith('CLI setup skipped (version: skip)');
      expect(mockedTc.downloadTool).not.toHaveBeenCalled();
    });

    it('throws error when version is "skip" and CLI is not available', async () => {
      mockedExec.exec.mockRejectedValue(new Error('Command not found'));

      await expect(ensureBoringCache({ version: 'skip' })).rejects.toThrow(
        'BoringCache CLI not found and cli-version is set to "skip"'
      );
    });

    it('skips download when CLI is already available', async () => {
      mockedExec.exec.mockImplementation(async (cmd, args, options) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from('boringcache v1.7.0'));
        }
        return 0;
      });

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCore.debug).toHaveBeenCalledWith('BoringCache CLI already available');
      expect(mockedTc.downloadTool).not.toHaveBeenCalled();
    });

    it('downloads CLI when not available', async () => {
      // First call (isCliAvailable) fails, subsequent calls succeed
      let callCount = 0;
      mockedExec.exec.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Command not found');
        }
        return 0;
      });

      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/downloaded');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cached');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0' });

      // Should download both binary and checksums
      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        'https://github.com/boringcache/cli/releases/download/v1.7.0/boringcache-linux-amd64'
      );
      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        'https://github.com/boringcache/cli/releases/download/v1.7.0/SHA256SUMS'
      );
      expect(mockedCore.addPath).toHaveBeenCalledWith('/tmp/cached');
    });

    it('uses cached version when available', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('Command not found'));
      mockedTc.find.mockReturnValue('/tmp/cached-version');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedTc.find).toHaveBeenCalledWith('boringcache', '1.7.0');
      expect(mockedTc.downloadTool).not.toHaveBeenCalled();
      expect(mockedCore.addPath).toHaveBeenCalledWith('/tmp/cached-version');
    });

    it('masks API token when provided', async () => {
      mockedExec.exec.mockImplementation(async (cmd, args, options) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from('boringcache v1.7.0'));
        }
        return 0;
      });

      process.env.BORINGCACHE_API_TOKEN = 'secret-token';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCore.setSecret).toHaveBeenCalledWith('secret-token');
    });

    it('normalizes version without v prefix', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('Command not found'));
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/downloaded');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cached');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: '1.0.0' });

      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        expect.stringContaining('/v1.0.0/')
      );
    });
  });

  describe('checksum verification', () => {
    beforeEach(() => {
      mockedExec.exec.mockRejectedValueOnce(new Error('Command not found'));
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/downloaded');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cached');
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';
    });

    it('verifies checksum by default', async () => {
      await ensureBoringCache({ version: 'v1.7.0' });

      // Should download SHA256SUMS
      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        'https://github.com/boringcache/cli/releases/download/v1.7.0/SHA256SUMS'
      );
      expect(mockedCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Checksum verified')
      );
    });

    it('skips verification when verify: false', async () => {
      await ensureBoringCache({ version: 'v1.7.0', verify: false });

      // Should only download binary, not checksums
      const downloadCalls = mockedTc.downloadTool.mock.calls;
      expect(downloadCalls).toHaveLength(1);
      expect(downloadCalls[0][0]).toContain('boringcache-linux-amd64');
      expect(downloadCalls[0][0]).not.toContain('SHA256SUMS');

      expect(mockedCore.warning).toHaveBeenCalledWith(
        'Checksum verification disabled - this is not recommended for production use'
      );
    });

    it('throws error when checksum not found in SHA256SUMS', async () => {
      mockedFs.promises.readFile.mockImplementation((path: any, encoding?: any) => {
        if (encoding === 'utf-8') {
          return Promise.resolve('abc123  some-other-file\n');
        }
        return Promise.resolve(MOCK_BINARY_CONTENT);
      });

      await expect(ensureBoringCache({ version: 'v1.7.0' })).rejects.toThrow(
        'Checksum not found for asset: boringcache-linux-amd64'
      );
    });

    it('throws error when SHA256SUMS download fails', async () => {
      mockedTc.downloadTool
        .mockResolvedValueOnce('/tmp/binary') // binary download succeeds
        .mockRejectedValueOnce(new Error('404 Not Found')); // checksums fails

      await expect(ensureBoringCache({ version: 'v1.7.0' })).rejects.toThrow(
        'Failed to fetch checksums'
      );
    });

    it('parses SHA256SUMS with single space separator', async () => {
      mockedFs.promises.readFile.mockImplementation((path: any, encoding?: any) => {
        if (encoding === 'utf-8') {
          return Promise.resolve(`${MOCK_BINARY_HASH} boringcache-linux-amd64\n`);
        }
        return Promise.resolve(MOCK_BINARY_CONTENT);
      });

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Checksum verified')
      );
    });

    it('parses SHA256SUMS with double space separator', async () => {
      mockedFs.promises.readFile.mockImplementation((path: any, encoding?: any) => {
        if (encoding === 'utf-8') {
          return Promise.resolve(`${MOCK_BINARY_HASH}  boringcache-linux-amd64\n`);
        }
        return Promise.resolve(MOCK_BINARY_CONTENT);
      });

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Checksum verified')
      );
    });
  });

  describe('execBoringCache', () => {
    it('executes boringcache command', async () => {
      mockedExec.exec.mockResolvedValue(0);

      const result = await execBoringCache(['restore', 'workspace', 'tag:path']);

      expect(mockedExec.exec).toHaveBeenCalledWith(
        'boringcache',
        ['restore', 'workspace', 'tag:path'],
        {}
      );
      expect(result).toBe(0);
    });

    it('passes options to exec', async () => {
      mockedExec.exec.mockResolvedValue(0);

      const options = { silent: true };
      await execBoringCache(['--version'], options);

      expect(mockedExec.exec).toHaveBeenCalledWith(
        'boringcache',
        ['--version'],
        options
      );
    });

    // Note: Windows-specific bash fallback is tested in integration tests
    // since process.platform cannot be easily mocked at runtime

    it('throws error when exec fails on current platform', async () => {
      mockedExec.exec.mockRejectedValue(new Error('Command failed'));

      // On non-Windows, error should be thrown directly
      // On Windows, if it's not the specific "Unable to locate" error, it should still throw
      await expect(execBoringCache(['--version'])).rejects.toThrow('Command failed');
    });
  });

  describe('platform detection', () => {
    beforeEach(() => {
      mockedExec.exec.mockRejectedValueOnce(new Error('not found'));
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/dl');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cache');
    });

    it('handles Linux x64', async () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        expect.stringContaining('boringcache-linux-amd64')
      );
    });

    it('handles Linux ARM64', async () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'ARM64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        expect.stringContaining('boringcache-linux-arm64')
      );
    });

    it('handles macOS', async () => {
      process.env.RUNNER_OS = 'macOS';
      process.env.RUNNER_ARCH = 'ARM64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        expect.stringContaining('boringcache-macos-14-arm64')
      );
    });

    it('handles Windows', async () => {
      process.env.RUNNER_OS = 'Windows';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedTc.downloadTool).toHaveBeenCalledWith(
        expect.stringContaining('boringcache-windows-2022-amd64.exe')
      );
    });
  });

  describe('getToolCacheInfo', () => {
    it('returns cache info with correct tool name and version', () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';
      mockedTc.find.mockReturnValue('');

      const info = getToolCacheInfo('v1.7.0');

      expect(info.toolName).toBe('boringcache');
      expect(info.version).toBe('1.7.0');
      expect(info.cachePath).toBeNull();
    });

    it('normalizes version without v prefix', () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';
      mockedTc.find.mockReturnValue('');

      const info = getToolCacheInfo('1.2.3');

      expect(info.version).toBe('1.2.3');
    });

    it('returns cache path when tool is cached', () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';
      mockedTc.find.mockReturnValue('/opt/hostedtoolcache/boringcache/1.7.0/x64');

      const info = getToolCacheInfo('v1.7.0');

      expect(info.cachePath).toBe('/opt/hostedtoolcache/boringcache/1.7.0/x64');
    });

    it('returns correct cache pattern', () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';
      process.env.RUNNER_TOOL_CACHE = '/custom/tool/cache';
      mockedTc.find.mockReturnValue('');

      const info = getToolCacheInfo('v1.7.0');

      expect(info.cachePattern).toBe('/custom/tool/cache/boringcache/1.7.0*');
    });

    it('returns platform-specific cache key', () => {
      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'ARM64';
      mockedTc.find.mockReturnValue('');

      const info = getToolCacheInfo('v1.7.0');

      expect(info.cacheKey).toBe('boringcache-1.7.0-linux-arm64');
    });
  });

  describe('automatic caching', () => {
    it('restores from actions/cache on startup', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('not found'));
      mockedCache.restoreCache.mockResolvedValue('boringcache-1.7.0-linux-x64');
      mockedTc.find.mockReturnValue('/opt/hostedtoolcache/boringcache/1.7.0/x64');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCache.restoreCache).toHaveBeenCalled();
      expect(mockedTc.downloadTool).not.toHaveBeenCalled();
    });

    it('saves to actions/cache after download', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('not found'));
      mockedCache.restoreCache.mockResolvedValue(undefined); // cache miss
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/dl');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cache');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCache.saveCache).toHaveBeenCalledWith(
        expect.any(Array),
        expect.stringContaining('boringcache-1.7.0-linux-x64')
      );
    });

    it('skips caching when cache option is false', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('not found'));
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/dl');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cache');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      await ensureBoringCache({ version: 'v1.7.0', cache: false });

      expect(mockedCache.restoreCache).not.toHaveBeenCalled();
      expect(mockedCache.saveCache).not.toHaveBeenCalled();
    });

    it('handles cache restore failure gracefully', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('not found'));
      mockedCache.restoreCache.mockRejectedValue(new Error('Cache service unavailable'));
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/dl');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cache');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      // Should not throw, just continue with download
      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedTc.downloadTool).toHaveBeenCalled();
    });

    it('handles cache save failure gracefully', async () => {
      mockedExec.exec.mockRejectedValueOnce(new Error('not found'));
      mockedCache.restoreCache.mockResolvedValue(undefined);
      mockedCache.saveCache.mockRejectedValue(new Error('Cache already exists'));
      mockedTc.find.mockReturnValue('');
      mockedTc.downloadTool.mockResolvedValue('/tmp/dl');
      mockedTc.cacheDir.mockResolvedValue('/tmp/cache');

      process.env.RUNNER_OS = 'Linux';
      process.env.RUNNER_ARCH = 'X64';

      // Should not throw
      await ensureBoringCache({ version: 'v1.7.0' });

      expect(mockedCore.addPath).toHaveBeenCalled();
    });
  });
});
