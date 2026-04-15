import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as cache from '@actions/cache';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { warnIfUsingLegacyApiToken } from './auth';

const TOOL_NAME = 'boringcache';
const GITHUB_RELEASES_BASE = 'https://github.com/boringcache/cli/releases/download';

export interface SetupOptions {
  version: string;
  token?: string;
  /** Override the CLI target/platform (for example linux-amd64 or linux-musl-amd64). Legacy distro aliases are normalized. */
  platform?: string;
  /** Enable automatic caching across workflow runs (default: true) */
  cache?: boolean;
  /** Verify SHA256 checksum of downloaded binary (default: true) */
  verify?: boolean;
  /** Export BORINGCACHE_REQUIRE_SERVER_SIGNATURE=1 unless already configured */
  requireServerSignature?: boolean;
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
  /** Platform cache key used to separate different CLI assets for the same version */
  platformKey: string;
}

/**
 * Get tool cache information for a specific version.
 * Use this to persist the tool cache across workflow runs with actions/cache.
 */
export function getToolCacheInfo(version: string, platformOverride?: string): ToolCacheInfo {
  const normalizedVersion = version.replace(/^v/, '');
  const platform = getPlatformInfo(platformOverride);
  const cachePath = tc.find(TOOL_NAME, normalizedVersion, platform.cacheKey);
  const toolCacheRoot = process.env.RUNNER_TOOL_CACHE || '/opt/hostedtoolcache';

  return {
    toolName: TOOL_NAME,
    version: normalizedVersion,
    cachePath: cachePath || null,
    cachePattern: `${toolCacheRoot}/${TOOL_NAME}/${normalizedVersion}*`,
    cacheKey: `${TOOL_NAME}-${normalizedVersion}-${platform.os}-${platform.cacheKey}`,
    platformKey: platform.cacheKey,
  };
}

interface PlatformInfo {
  os: string;
  arch: string;
  assetName: string;
  fallbackAssetName?: string;
  isWindows: boolean;
  cacheKey: string;
}

function getPlatformInfo(platformOverride?: string): PlatformInfo {
  if (platformOverride) {
    const normalizedPlatform = platformOverride.trim().toLowerCase();
    const isWindows = normalizedPlatform.includes('windows');
    const arch = normalizedPlatform.includes('arm64') ? 'arm64' : 'amd64';
    const legacyAssetName = `boringcache-${normalizedPlatform}${isWindows && !normalizedPlatform.endsWith('.exe') ? '.exe' : ''}`;

    if (isWindows) {
      const assetName = `boringcache-windows-${arch}.exe`;
      return {
        os: 'windows',
        arch,
        assetName,
        fallbackAssetName: legacyAssetName === assetName ? undefined : legacyAssetName,
        isWindows: true,
        cacheKey: arch,
      };
    }

    if (normalizedPlatform.includes('macos') || normalizedPlatform.includes('darwin')) {
      const assetName = 'boringcache-macos-universal';
      return {
        os: 'macos',
        arch,
        assetName,
        fallbackAssetName: legacyAssetName === assetName ? undefined : legacyAssetName,
        isWindows: false,
        cacheKey: 'universal',
      };
    }

    const usesMusl = normalizedPlatform.includes('alpine') || normalizedPlatform.includes('musl');
    const genericPlatform = `linux${usesMusl ? '-musl' : ''}-${arch}`;
    const assetName = `boringcache-${genericPlatform}`;

    return {
      os: 'linux',
      arch,
      assetName,
      fallbackAssetName: legacyAssetName === assetName ? undefined : legacyAssetName,
      isWindows: false,
      cacheKey: usesMusl ? `musl-${arch}` : arch,
    };
  }

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
      assetName = 'boringcache-macos-universal';
      break;
    case 'Windows':
      assetName = normalizedArch === 'ARM64' ? 'boringcache-windows-arm64.exe' : 'boringcache-windows-amd64.exe';
      break;
    default:
      throw new Error(`Unsupported platform: OS=${runnerOS}, ARCH=${runnerArch}`);
  }

  return {
    os: normalizedOS.toLowerCase(),
    arch: normalizedArch.toLowerCase(),
    assetName,
    isWindows,
    cacheKey:
      normalizedOS === 'macOS'
        ? 'universal'
        : normalizedArch === 'ARM64'
          ? 'arm64'
          : 'amd64',
  };
}

function getDownloadUrl(version: string, assetName: string): string {
  return `${GITHUB_RELEASES_BASE}/${version}/${assetName}`;
}

function getChecksumsUrl(version: string): string {
  return `${GITHUB_RELEASES_BASE}/${version}/SHA256SUMS`;
}

/**
 * Compute SHA256 hash of a file
 */
async function computeFileHash(filePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * Parse SHA256SUMS file content and extract checksum for a specific asset
 * Format: <sha256>  <filename> (two spaces between hash and filename)
 * or: <sha256> <filename> (single space)
 */
function parseChecksums(content: string, assetName: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match either "hash  filename" or "hash filename"
    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (match) {
      const [, hash, filename] = match;
      // Match exact filename or filename at end of path
      if (filename === assetName || filename.endsWith(`/${assetName}`)) {
        return hash.toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Download SHA256SUMS and get expected checksum for the asset
 */
async function getExpectedChecksum(version: string, assetName: string): Promise<string> {
  const checksumsUrl = getChecksumsUrl(version);
  core.debug(`Downloading checksums from: ${checksumsUrl}`);

  try {
    const checksumsPath = await tc.downloadTool(checksumsUrl);
    const content = await fs.promises.readFile(checksumsPath, 'utf-8');
    const checksum = parseChecksums(content, assetName);

    if (!checksum) {
      throw new Error(`Checksum not found for asset: ${assetName}`);
    }

    return checksum;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch checksums from ${checksumsUrl}: ${msg}`);
  }
}

/**
 * Verify file checksum matches expected value
 */
async function verifyChecksum(filePath: string, expectedChecksum: string, assetName: string): Promise<void> {
  const actualChecksum = await computeFileHash(filePath);

  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Checksum verification failed for ${assetName}:\n` +
      `  Expected: ${expectedChecksum}\n` +
      `  Actual:   ${actualChecksum}`
    );
  }

  core.info(`Checksum verified for ${assetName}`);
}

async function downloadAndInstall(
  version: string,
  platform: PlatformInfo,
  verify: boolean
): Promise<string> {
  let resolvedAssetName = platform.assetName;
  let downloadUrl = getDownloadUrl(version, resolvedAssetName);
  core.info(`Downloading BoringCache CLI from: ${downloadUrl}`);

  let downloadedPath: string;
  try {
    downloadedPath = await tc.downloadTool(downloadUrl);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (platform.fallbackAssetName) {
      resolvedAssetName = platform.fallbackAssetName;
      downloadUrl = getDownloadUrl(version, resolvedAssetName);
      core.info(
        `Primary CLI asset ${platform.assetName} unavailable (${msg}); trying legacy fallback: ${resolvedAssetName}`
      );
      try {
        downloadedPath = await tc.downloadTool(downloadUrl);
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        if (fallbackMsg.includes('404')) {
          throw new Error(
            `Failed to download BoringCache CLI ${version} (${platform.assetName}, fallback ${resolvedAssetName}): ` +
            'release asset not found. The requested cli-version may not be published yet.'
          );
        }
        throw new Error(
          `Failed to download BoringCache CLI ${version} (${platform.assetName}, fallback ${resolvedAssetName}): ${fallbackMsg}`
        );
      }
    } else if (msg.includes('404')) {
      throw new Error(
        `Failed to download BoringCache CLI ${version} (${platform.assetName}) from ${downloadUrl}: ` +
        'release asset not found. The requested cli-version may not be published yet.'
      );
    } else {
      throw new Error(
        `Failed to download BoringCache CLI ${version} (${platform.assetName}) from ${downloadUrl}: ${msg}`
      );
    }
  }

  // Verify checksum if enabled
  if (verify) {
    const expectedChecksum = await getExpectedChecksum(version, resolvedAssetName);
    await verifyChecksum(downloadedPath, expectedChecksum, resolvedAssetName);
  } else {
    core.warning('Checksum verification disabled - this is not recommended for production use');
  }

  const binaryName = platform.isWindows ? 'boringcache.exe' : 'boringcache';
  const installDir = path.join(os.tmpdir(), 'boringcache-install', version);
  await fs.promises.mkdir(installDir, { recursive: true });

  const binaryPath = path.join(installDir, binaryName);
  await fs.promises.copyFile(downloadedPath, binaryPath);

  if (!platform.isWindows) {
    await fs.promises.chmod(binaryPath, 0o755);
  }

  const cachedPath = await tc.cacheDir(installDir, TOOL_NAME, version.replace(/^v/, ''), platform.cacheKey);
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
  warnIfUsingLegacyApiToken();

  const secrets = new Set(
    [
      options.token,
      process.env.BORINGCACHE_RESTORE_TOKEN,
      process.env.BORINGCACHE_SAVE_TOKEN,
      process.env.BORINGCACHE_API_TOKEN,
    ].filter((value): value is string => Boolean(value))
  );

  for (const secret of secrets) {
    core.setSecret(secret);
  }

  const shouldRequireServerSignature = options.requireServerSignature !== false;
  if (shouldRequireServerSignature && !process.env.BORINGCACHE_REQUIRE_SERVER_SIGNATURE) {
    core.exportVariable('BORINGCACHE_REQUIRE_SERVER_SIGNATURE', '1');
    core.info('BORINGCACHE_REQUIRE_SERVER_SIGNATURE=1 (strict server signature verification enabled)');
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
  const platform = getPlatformInfo(options.platform);
  const enableCache = options.cache !== false;
  const enableVerify = options.verify !== false; // Default: true

  core.info(`Installing BoringCache CLI ${normalizedVersion}...`);

  // Get cache info for this version
  const cacheInfo = getToolCacheInfo(normalizedVersion, options.platform);
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
  let cachedPath = tc.find(TOOL_NAME, normalizedVersion.replace(/^v/, ''), cacheInfo.platformKey);

  if (cachedPath && enableVerify) {
    const binaryName = platform.isWindows ? 'boringcache.exe' : 'boringcache';
    const cachedBinary = path.join(cachedPath, binaryName);
    if (fs.existsSync(cachedBinary)) {
      try {
        const expectedChecksum = await getExpectedChecksum(normalizedVersion, platform.assetName);
        const actualChecksum = await computeFileHash(cachedBinary);
        if (actualChecksum !== expectedChecksum) {
          core.warning(`Cached CLI binary is stale (checksum mismatch), re-downloading`);
          cachedPath = '';
        }
      } catch (error) {
        core.debug(`Cache validation failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  if (cachedPath) {
    core.info(`Using cached BoringCache CLI`);
    toolPath = cachedPath;
  } else {
    toolPath = await downloadAndInstall(normalizedVersion, platform, enableVerify);

    if (enableCache) {
      try {
        await cache.saveCache(cachePaths, cacheInfo.cacheKey);
        core.info(`Saved CLI to cache (key: ${cacheInfo.cacheKey})`);
      } catch (error) {
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
