import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as cache from '@actions/cache';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TOOL_NAME = 'boringcache';
const GITHUB_RELEASES_BASE = 'https://github.com/boringcache/cli/releases/download';

export interface SetupOptions {
  version: string;
  token?: string;
  /** Enable automatic caching across workflow runs (default: true) */
  cache?: boolean;
}

export interface ToolCacheInfo {
  /** Tool name used in cache */
  toolName: string;
  /** Normalized version (without 'v' prefix) */
  version: string;
  /** Full path to tool cache directory (or null if not cached) */
  cachePath: string | null;
  /** Path pattern for use with actions/cache */
  cachePattern: string;
  /** Cache key for use with actions/cache */
  cacheKey: string;
}

/**
 * Get tool cache information for a specific version.
 * Use this to persist the tool cache across workflow runs with actions/cache.
 */
export function getToolCacheInfo(version: string): ToolCacheInfo {
  const normalizedVersion = version.replace(/^v/, '');
  const platform = getPlatformInfo();
  const cachePath = tc.find(TOOL_NAME, normalizedVersion);
  const toolCacheRoot = process.env.RUNNER_TOOL_CACHE || '/opt/hostedtoolcache';

  return {
    toolName: TOOL_NAME,
    version: normalizedVersion,
    cachePath: cachePath || null,
    cachePattern: `${toolCacheRoot}/${TOOL_NAME}/${normalizedVersion}*`,
    cacheKey: `${TOOL_NAME}-${normalizedVersion}-${platform.os}-${platform.arch}`,
  };
}

interface PlatformInfo {
  os: string;
  arch: string;
  assetName: string;
  isWindows: boolean;
}

function getPlatformInfo(): PlatformInfo {
  const runnerOS = process.env.RUNNER_OS || os.platform();
  const runnerArch = process.env.RUNNER_ARCH || os.arch();

  let normalizedOS = runnerOS;
  let normalizedArch = runnerArch;

  if (runnerOS === 'darwin' || runnerOS === 'Darwin') {
    normalizedOS = 'macOS';
  } else if (runnerOS === 'win32' || runnerOS === 'Windows') {
    normalizedOS = 'Windows';
  } else if (runnerOS === 'linux' || runnerOS === 'Linux') {
    normalizedOS = 'Linux';
  }

  if (runnerArch === 'x64' || runnerArch === 'X64' || runnerArch === 'amd64') {
    normalizedArch = 'X64';
  } else if (runnerArch === 'arm64' || runnerArch === 'ARM64' || runnerArch === 'aarch64') {
    normalizedArch = 'ARM64';
  }

  const isWindows = normalizedOS === 'Windows';
  let assetName: string;

  switch (normalizedOS) {
    case 'Linux':
      assetName = normalizedArch === 'ARM64' ? 'boringcache-linux-arm64' : 'boringcache-linux-amd64';
      break;
    case 'macOS':
      assetName = 'boringcache-macos-14-arm64';
      break;
    case 'Windows':
      assetName = 'boringcache-windows-2022-amd64.exe';
      break;
    default:
      throw new Error(`Unsupported platform: OS=${runnerOS}, ARCH=${runnerArch}`);
  }

  return {
    os: normalizedOS.toLowerCase(),
    arch: normalizedArch.toLowerCase(),
    assetName,
    isWindows,
  };
}

function getDownloadUrl(version: string, assetName: string): string {
  return `${GITHUB_RELEASES_BASE}/${version}/${assetName}`;
}

async function downloadAndInstall(version: string, platform: PlatformInfo): Promise<string> {
  const downloadUrl = getDownloadUrl(version, platform.assetName);
  core.info(`Downloading BoringCache CLI from: ${downloadUrl}`);

  const downloadedPath = await tc.downloadTool(downloadUrl);

  const binaryName = platform.isWindows ? 'boringcache.exe' : 'boringcache';
  const installDir = path.join(os.tmpdir(), 'boringcache-install', version);
  await fs.promises.mkdir(installDir, { recursive: true });

  const binaryPath = path.join(installDir, binaryName);
  await fs.promises.copyFile(downloadedPath, binaryPath);

  if (!platform.isWindows) {
    await fs.promises.chmod(binaryPath, 0o755);
  }

  const cachedPath = await tc.cacheDir(installDir, TOOL_NAME, version.replace(/^v/, ''));
  return cachedPath;
}

export async function isCliAvailable(): Promise<boolean> {
  try {
    let output = '';
    const result = await exec.exec('boringcache', ['--version'], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => { output += data.toString(); },
        stderr: (data: Buffer) => { output += data.toString(); }
      }
    });
    return result === 0 && output.includes('boringcache');
  } catch {
    return false;
  }
}

export async function ensureBoringCache(options: SetupOptions): Promise<void> {
  const token = options.token || process.env.BORINGCACHE_API_TOKEN;
  if (token) {
    core.setSecret(token);
  }

  if (options.version === 'skip') {
    core.debug('CLI setup skipped (version: skip)');
    if (await isCliAvailable()) {
      return;
    }
    throw new Error('BoringCache CLI not found and cli-version is set to "skip"');
  }

  if (await isCliAvailable()) {
    core.debug('BoringCache CLI already available');
    return;
  }

  const version = options.version;
  const normalizedVersion = version.startsWith('v') ? version : `v${version}`;
  const platform = getPlatformInfo();
  const enableCache = options.cache !== false;

  core.info(`Installing BoringCache CLI ${normalizedVersion}...`);

  // Get cache info for this version
  const cacheInfo = getToolCacheInfo(normalizedVersion);
  const toolCacheRoot = process.env.RUNNER_TOOL_CACHE || '/opt/hostedtoolcache';
  const cachePaths = [`${toolCacheRoot}/${TOOL_NAME}`];

  // Try to restore from actions/cache first
  let restoredFromCache = false;
  if (enableCache) {
    try {
      const cacheKey = await cache.restoreCache(cachePaths, cacheInfo.cacheKey);
      if (cacheKey) {
        core.info(`Restored CLI from cache (key: ${cacheKey})`);
        restoredFromCache = true;
      }
    } catch (error) {
      core.debug(`Cache restore failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  let toolPath: string;
  const cachedPath = tc.find(TOOL_NAME, normalizedVersion.replace(/^v/, ''));
  if (cachedPath) {
    core.info(`Using cached BoringCache CLI`);
    toolPath = cachedPath;
  } else {
    toolPath = await downloadAndInstall(normalizedVersion, platform);

    // Save to actions/cache for future workflow runs
    if (enableCache && !restoredFromCache) {
      try {
        await cache.saveCache(cachePaths, cacheInfo.cacheKey);
        core.info(`Saved CLI to cache (key: ${cacheInfo.cacheKey})`);
      } catch (error) {
        // Cache save can fail if key already exists (race condition) - that's ok
        core.debug(`Cache save failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  core.addPath(toolPath);
  core.info(`BoringCache CLI ${normalizedVersion} ready`);
}

export async function execBoringCache(
  args: string[],
  options: exec.ExecOptions = {}
): Promise<number> {
  const isWindows = os.platform() === 'win32';

  try {
    return await exec.exec('boringcache', args, options);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);

    if (isWindows && msg.includes('Unable to locate executable file')) {
      const quoted = ['boringcache', ...args.map(a => {
        const escaped = a.replace(/"/g, '\\"');
        return /\s/.test(escaped) ? `"${escaped}"` : escaped;
      })].join(' ');
      return await exec.exec('bash', ['-lc', quoted], options);
    }

    throw error;
  }
}
