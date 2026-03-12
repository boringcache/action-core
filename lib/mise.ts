import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tc from '@actions/tool-cache';

const isWindows = process.platform === 'win32';
const MISE_TOOL_NAME = 'mise';
const MISE_RELEASES_BASE = 'https://github.com/jdx/mise/releases/download';
const DEFAULT_MISE_VERSION = 'v2026.3.8';

export interface MiseToolOptions {
  env?: Record<string, string>;
  global?: boolean;
  label?: string;
}

export interface MiseToolVersion {
  name: string;
  version: string;
}

interface MisePlatformInfo {
  os: string;
  arch: string;
  assetName: string;
  binaryName: string;
  isWindows: boolean;
}

export function getMiseBinPath(): string {
  const homedir = os.homedir();
  return isWindows
    ? path.join(homedir, '.local', 'bin', 'mise.exe')
    : path.join(homedir, '.local', 'bin', 'mise');
}

export function getMiseDataDir(): string {
  if (isWindows) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mise');
  }
  return path.join(os.homedir(), '.local', 'share', 'mise');
}

export function getMiseInstallsDir(): string {
  return process.env.MISE_INSTALLS_DIR || path.join(getMiseDataDir(), 'installs');
}

export function getMiseShimsDir(): string {
  return path.join(getMiseDataDir(), 'shims');
}

export async function installMise(): Promise<void> {
  const version = getMiseVersion();
  const normalizedVersion = version.replace(/^v/, '');
  const platform = getMisePlatformInfo();
  const cacheInfo = getMiseToolCacheInfo(version, platform);
  const toolCacheRoot = process.env.RUNNER_TOOL_CACHE || '/opt/hostedtoolcache';
  const cachePaths = [`${toolCacheRoot}/${MISE_TOOL_NAME}`];

  let restoredFromCache = false;
  try {
    const cacheKey = await cache.restoreCache(cachePaths, cacheInfo.cacheKey);
    if (cacheKey) {
      core.info(`Restored mise from cache (key: ${cacheKey})`);
      restoredFromCache = true;
    }
  } catch (error) {
    core.debug(`mise cache restore failed: ${error instanceof Error ? error.message : error}`);
  }

  let toolPath = tc.find(MISE_TOOL_NAME, normalizedVersion);
  if (toolPath) {
    core.info(`Using cached mise ${version}`);
  } else {
    core.info(`Installing mise ${version}...`);
    toolPath = await downloadAndInstallMise(version, platform);

    try {
      await cache.saveCache(cachePaths, cacheInfo.cacheKey);
      core.info(`Saved mise to cache (key: ${cacheInfo.cacheKey})`);
    } catch (error) {
      core.debug(`mise cache save failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (!toolPath) {
    throw new Error(`Failed to install mise ${version}`);
  }

  if (restoredFromCache && !tc.find(MISE_TOOL_NAME, normalizedVersion)) {
    core.debug(`mise cache restored but tool cache lookup for ${version} remained empty`);
  }

  core.addPath(toolPath);
  core.addPath(getMiseShimsDir());
  core.info(`mise ${version} ready`);
}

function getMiseVersion(): string {
  const value = process.env.MISE_VERSION || DEFAULT_MISE_VERSION;
  return value.startsWith('v') ? value : `v${value}`;
}

function getMisePlatformInfo(): MisePlatformInfo {
  const runnerOS = process.env.RUNNER_OS || os.platform();
  const runnerArch = process.env.RUNNER_ARCH || os.arch();

  const osName = normalizeRunnerOs(runnerOS);
  const arch = normalizeRunnerArch(runnerArch);
  const version = getMiseVersion();

  if (osName === 'windows') {
    return {
      os: osName,
      arch,
      assetName: `mise-${version}-windows-${arch}.zip`,
      binaryName: 'mise.exe',
      isWindows: true,
    };
  }

  return {
    os: osName,
    arch,
    assetName: `mise-${version}-${osName}-${arch}`,
    binaryName: 'mise',
    isWindows: false,
  };
}

function normalizeRunnerOs(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'darwin' || normalized === 'macos') {
    return 'macos';
  }
  if (normalized === 'win32' || normalized === 'windows') {
    return 'windows';
  }
  if (normalized === 'linux') {
    return 'linux';
  }
  throw new Error(`Unsupported platform for mise: OS=${value}`);
}

function normalizeRunnerArch(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64') {
    return 'x64';
  }
  if (normalized === 'arm64' || normalized === 'aarch64') {
    return 'arm64';
  }
  throw new Error(`Unsupported architecture for mise: ARCH=${value}`);
}

function getMiseToolCacheInfo(version: string, platform: MisePlatformInfo): {
  cacheKey: string;
  cachePattern: string;
} {
  const normalizedVersion = version.replace(/^v/, '');
  const toolCacheRoot = process.env.RUNNER_TOOL_CACHE || '/opt/hostedtoolcache';

  return {
    cacheKey: `${MISE_TOOL_NAME}-${normalizedVersion}-${platform.os}-${platform.arch}`,
    cachePattern: `${toolCacheRoot}/${MISE_TOOL_NAME}/${normalizedVersion}*`,
  };
}

function getMiseDownloadUrl(version: string, assetName: string): string {
  return `${MISE_RELEASES_BASE}/${version}/${assetName}`;
}

function getMiseChecksumsUrl(version: string): string {
  return `${MISE_RELEASES_BASE}/${version}/SHASUMS256.txt`;
}

async function computeFileHash(filePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function parseChecksums(content: string, assetName: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) {
      continue;
    }

    const [, hash, filename] = match;
    if (filename === assetName || filename.endsWith(`/${assetName}`)) {
      return hash.toLowerCase();
    }
  }

  return null;
}

async function getExpectedChecksum(version: string, assetName: string): Promise<string> {
  const checksumsPath = await tc.downloadTool(getMiseChecksumsUrl(version));
  const content = await fs.promises.readFile(checksumsPath, 'utf-8');
  const checksum = parseChecksums(content, assetName);

  if (!checksum) {
    throw new Error(`Checksum not found for mise asset: ${assetName}`);
  }

  return checksum;
}

async function verifyChecksum(filePath: string, expectedChecksum: string, assetName: string): Promise<void> {
  const actualChecksum = await computeFileHash(filePath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Checksum verification failed for ${assetName}:\n` +
      `  Expected: ${expectedChecksum}\n` +
      `  Actual:   ${actualChecksum}`,
    );
  }
}

async function downloadAndInstallMise(version: string, platform: MisePlatformInfo): Promise<string> {
  const downloadUrl = getMiseDownloadUrl(version, platform.assetName);
  core.info(`Downloading mise from: ${downloadUrl}`);

  const downloadedPath = await tc.downloadTool(downloadUrl);
  const expectedChecksum = await getExpectedChecksum(version, platform.assetName);
  await verifyChecksum(downloadedPath, expectedChecksum, platform.assetName);

  const installDir = path.join(os.tmpdir(), 'mise-install', version.replace(/^v/, ''));
  await fs.promises.mkdir(installDir, { recursive: true });

  const binaryPath = path.join(installDir, platform.binaryName);
  if (platform.isWindows) {
    const extractedPath = await tc.extractZip(downloadedPath);
    const extractedBinary = await findMiseBinary(extractedPath, platform.binaryName);
    await fs.promises.copyFile(extractedBinary, binaryPath);
  } else {
    await fs.promises.copyFile(downloadedPath, binaryPath);
    await fs.promises.chmod(binaryPath, 0o755);
  }

  return tc.cacheDir(installDir, MISE_TOOL_NAME, version.replace(/^v/, ''));
}

async function findMiseBinary(extractedPath: string, binaryName: string): Promise<string> {
  const candidates = [
    path.join(extractedPath, 'mise', 'bin', binaryName),
    path.join(extractedPath, 'bin', binaryName),
    path.join(extractedPath, binaryName),
  ];

  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to locate ${binaryName} in extracted mise archive`);
}

export async function installMiseTool(
  toolName: string,
  version: string,
  options: MiseToolOptions = {},
): Promise<void> {
  const spec = `${toolName}@${version}`;
  const label = options.label || toolName;
  const global = options.global ?? true;

  core.info(`Installing ${label} ${version} via mise...`);
  await exec.exec(getMiseBinPath(), ['install', spec], { env: options.env });
  await exec.exec(getMiseBinPath(), buildUseArgs(spec, global), { env: options.env });
}

export async function activateMiseTool(
  toolName: string,
  version: string,
  options: MiseToolOptions = {},
): Promise<void> {
  const spec = `${toolName}@${version}`;
  const label = options.label || toolName;
  const global = options.global ?? true;

  core.info(`Activating ${label} ${version}...`);
  await exec.exec(getMiseBinPath(), buildUseArgs(spec, global), { env: options.env });
}

export async function reshimMise(force = true): Promise<void> {
  const args = force ? ['reshim', '-f'] : ['reshim'];
  core.info('Refreshing mise shims...');
  await exec.exec(getMiseBinPath(), args);
}

function buildUseArgs(spec: string, global: boolean): string[] {
  return global ? ['use', '-g', spec] : ['use', spec];
}

export async function readToolVersions(workingDir: string): Promise<MiseToolVersion[]> {
  const toolVersionsPath = path.join(workingDir, '.tool-versions');

  try {
    const content = await fs.promises.readFile(toolVersionsPath, 'utf-8');
    const tools = new Map<string, string>();

    for (const rawLine of content.split(/\r?\n/)) {
      const line = stripTomlComment(rawLine).trim();
      if (!line) {
        continue;
      }

      const [toolName, version] = line.split(/\s+/, 3);
      if (!toolName || !version) {
        continue;
      }

      tools.set(normalizeToolName(toolName), version.trim());
    }

    return Array.from(tools, ([name, version]) => ({ name, version }));
  } catch {
    return [];
  }
}

export async function readToolVersionsValue(workingDir: string, toolName: string): Promise<string | null> {
  const normalizedToolName = normalizeToolName(toolName);
  const tools = await readToolVersions(workingDir);
  return tools.find((tool) => tool.name === normalizedToolName)?.version || null;
}

export async function readMiseTomlTools(workingDir: string): Promise<MiseToolVersion[]> {
  const miseToml = path.join(workingDir, 'mise.toml');

  try {
    const content = await fs.promises.readFile(miseToml, 'utf-8');
    const toolsBlock = extractToolsBlock(content);
    if (!toolsBlock) {
      return [];
    }

    const tools = new Map<string, string>();
    const lines = toolsBlock.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const parsedLine = stripTomlComment(lines[index]).trim();
      if (!parsedLine) {
        continue;
      }

      const assignmentMatch = parsedLine.match(/^([A-Za-z0-9._-]+)\s*=\s*(.+)$/);
      if (!assignmentMatch) {
        continue;
      }

      const [, rawToolName, rawValue] = assignmentMatch;
      const toolName = normalizeToolName(rawToolName);
      const value = rawValue.trim();

      const stringVersion = value.match(/^["']([^"']+)["']$/);
      if (stringVersion?.[1]) {
        tools.set(toolName, stringVersion[1]);
        continue;
      }

      const inlineVersion = extractInlineTableVersion(value);
      if (inlineVersion) {
        tools.set(toolName, inlineVersion);
        continue;
      }

      if (value.startsWith('{')) {
        let blockValue = value;
        let braceDepth = countBraceDelta(value);

        while (braceDepth > 0 && index + 1 < lines.length) {
          index += 1;
          const nextLine = stripTomlComment(lines[index]).trim();
          blockValue = `${blockValue}\n${nextLine}`;
          braceDepth += countBraceDelta(nextLine);
        }

        const blockVersion = extractInlineTableVersion(blockValue);
        if (blockVersion) {
          tools.set(toolName, blockVersion);
        }
      }
    }

    return Array.from(tools, ([name, version]) => ({ name, version }));
  } catch {
    return [];
  }
}

export async function readMiseTomlVersion(workingDir: string, toolName: string): Promise<string | null> {
  const normalizedToolName = normalizeToolName(toolName);
  const tools = await readMiseTomlTools(workingDir);
  return tools.find((tool) => tool.name === normalizedToolName)?.version || null;
}

export async function readProjectMiseTools(workingDir: string): Promise<MiseToolVersion[]> {
  const toolVersions = await readToolVersions(workingDir);
  const miseTomlTools = await readMiseTomlTools(workingDir);
  const merged = new Map<string, string>();

  for (const tool of toolVersions) {
    merged.set(tool.name, tool.version);
  }

  for (const tool of miseTomlTools) {
    merged.set(tool.name, tool.version);
  }

  return Array.from(merged, ([name, version]) => ({ name, version }));
}

function extractToolsBlock(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const block: string[] = [];
  let inToolsBlock = false;

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!inToolsBlock) {
      if (line === '[tools]') {
        inToolsBlock = true;
      }
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      break;
    }

    block.push(rawLine);
  }

  return inToolsBlock ? block.join('\n') : null;
}

function extractInlineTableVersion(value: string): string | null {
  const versionMatch = value.match(/\bversion\s*=\s*["']([^"']+)["']/);
  return versionMatch?.[1] || null;
}

function countBraceDelta(value: string): number {
  let delta = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let isEscaped = false;

  for (const character of value) {
    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (character === '\\' && inDoubleQuote) {
      isEscaped = true;
      continue;
    }

    if (!inDoubleQuote && character === '\'') {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && character === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }

  return delta;
}

function stripTomlComment(value: string): string {
  let result = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let isEscaped = false;

  for (const character of value) {
    if (isEscaped) {
      result += character;
      isEscaped = false;
      continue;
    }

    if (character === '\\' && inDoubleQuote) {
      result += character;
      isEscaped = true;
      continue;
    }

    if (!inDoubleQuote && character === '\'') {
      inSingleQuote = !inSingleQuote;
      result += character;
      continue;
    }

    if (!inSingleQuote && character === '"') {
      inDoubleQuote = !inDoubleQuote;
      result += character;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && character === '#') {
      break;
    }

    result += character;
  }

  return result;
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}
