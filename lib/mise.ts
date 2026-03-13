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

interface MiseLsEntry {
  version?: string;
  installed?: boolean;
}

interface ToolVersionProbe {
  command: string;
  args: string[];
  stream?: 'stdout' | 'stderr' | 'combined';
  versionPattern?: RegExp;
}

export type MiseVersionScope = 'major' | 'minor' | 'patch';

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

export function slugMiseTagPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');

  return normalized || 'unknown';
}

export function scopeMiseToolVersion(version: string, scope: MiseVersionScope = 'patch'): string {
  const normalized = version.trim().replace(/^v(?=\d)/, '');
  const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);

  if (!match) {
    return slugMiseTagPart(normalized);
  }

  const [, major, minor, patch] = match;
  if (scope === 'major' || !minor) {
    return major;
  }
  if (scope === 'minor' || !patch) {
    return `${major}.${minor}`;
  }
  return `${major}.${minor}.${patch}`;
}

export function buildMiseToolTag(
  tools: MiseToolVersion[],
  scope: MiseVersionScope = 'patch',
): string {
  return tools
    .map((tool) => `${slugMiseTagPart(tool.name)}-${slugMiseTagPart(scopeMiseToolVersion(tool.version, scope))}`)
    .sort()
    .join('-');
}

export function buildMiseRuntimeTag(
  prefix: string,
  tools: MiseToolVersion[],
  scope: MiseVersionScope = 'patch',
): string {
  const toolTag = buildMiseToolTag(tools, scope);
  if (!toolTag) {
    return slugMiseTagPart(prefix);
  }
  return `${slugMiseTagPart(prefix)}-mise-${toolTag}`;
}

export async function hasMiseToolVersion(toolName: string, version: string): Promise<boolean> {
  const normalizedTool = normalizeToolName(toolName);
  let output = '';

  const exitCode = await exec.exec(
    getMiseBinPath(),
    ['ls', normalizedTool, '--installed', '--json'],
    {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString();
        },
      },
    },
  );

  if (exitCode !== 0 || !output.trim()) {
    return false;
  }

  let entries: MiseLsEntry[];
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      entries = parsed;
    } else if (Array.isArray((parsed as { versions?: unknown[] })?.versions)) {
      entries = (parsed as { versions: MiseLsEntry[] }).versions;
    } else {
      return false;
    }
  } catch {
    return false;
  }

  return entries.some((entry) => entry.installed !== false && isMatchingToolVersion(version, entry.version || ''));
}

export async function hasToolVersionOnPath(toolName: string, version: string): Promise<boolean> {
  const normalizedTool = normalizeToolName(toolName);
  const probes = getToolVersionProbes(normalizedTool);

  for (const probe of probes) {
    const detectedVersion = await detectToolVersion(probe);
    if (detectedVersion && isMatchingToolVersion(version, detectedVersion)) {
      return true;
    }
  }

  return false;
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

  await materializeMiseBinary(toolPath, platform);
  core.addPath(toolPath);
  core.addPath(path.dirname(getMiseBinPath()));
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

async function materializeMiseBinary(toolPath: string, platform: MisePlatformInfo): Promise<void> {
  const sourceBinary = path.join(toolPath, platform.binaryName);
  const targetBinary = getMiseBinPath();

  await fs.promises.mkdir(path.dirname(targetBinary), { recursive: true });
  await fs.promises.copyFile(sourceBinary, targetBinary);

  if (!platform.isWindows) {
    await fs.promises.chmod(targetBinary, 0o755);
  }
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

function normalizeToolVersion(value: string): string {
  return value.trim().replace(/^v(?=\d)/, '');
}

function isMatchingToolVersion(requested: string, candidate: string): boolean {
  const normalizedRequested = normalizeToolVersion(requested);
  const normalizedCandidate = normalizeToolVersion(candidate);

  if (!normalizedRequested || !normalizedCandidate) {
    return false;
  }

  const requestedParts = extractNumericVersionParts(normalizedRequested);
  const candidateParts = extractNumericVersionParts(normalizedCandidate);

  if (requestedParts.length > 0 || candidateParts.length > 0) {
    if (requestedParts.length === 0 || requestedParts.length > candidateParts.length) {
      return false;
    }

    return requestedParts.every((part, index) => part === candidateParts[index]);
  }

  return slugMiseTagPart(normalizedRequested) === slugMiseTagPart(normalizedCandidate);
}

function extractNumericVersionParts(value: string): string[] {
  const baseVersion = normalizeToolVersion(value).split('+')[0].trim();
  const numericPrefix = baseVersion.match(/^\d+(?:\.\d+)*/)?.[0];

  if (!numericPrefix) {
    return [];
  }

  return numericPrefix
    .split('.')
    .map(normalizeVersionSegment)
    .filter(Boolean);
}

function normalizeVersionSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const numericMatch = trimmed.match(/^\d+/);
  return numericMatch ? numericMatch[0] : trimmed;
}

async function detectToolVersion(probe: ToolVersionProbe): Promise<string | null> {
  let stdout = '';
  let stderr = '';
  let exitCode: number;

  try {
    exitCode = await exec.exec(
      probe.command,
      probe.args,
      {
        ignoreReturnCode: true,
        silent: true,
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          },
          stderr: (data: Buffer) => {
            stderr += data.toString();
          },
        },
      },
    );
  } catch (error) {
    core.debug(
      `Skipping PATH probe for ${probe.command}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (exitCode !== 0) {
    return null;
  }

  const output = probe.stream === 'stderr'
    ? stderr
    : probe.stream === 'combined'
      ? `${stdout}\n${stderr}`
      : stdout;

  return extractVersionFromOutput(output, probe.versionPattern);
}

function extractVersionFromOutput(output: string, versionPattern?: RegExp): string | null {
  const pattern = versionPattern || /\bv?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\b/;
  const match = output.match(pattern);

  if (!match) {
    return null;
  }

  return match[1] || match[0] || null;
}

function getToolVersionProbes(toolName: string): ToolVersionProbe[] {
  switch (toolName) {
    case 'bazel':
      return [
        { command: 'bazel', args: ['--version'], versionPattern: /bazel\s+([0-9A-Za-z.+-]+)/i },
        { command: 'bazelisk', args: ['version'], versionPattern: /Build label:\s*([0-9A-Za-z.+-]+)/i, stream: 'combined' },
      ];
    case 'bun':
      return [{ command: 'bun', args: ['--version'] }];
    case 'elixir':
      return [{ command: 'elixir', args: ['--version'], versionPattern: /Elixir\s+([0-9A-Za-z.+-]+)/i, stream: 'combined' }];
    case 'erlang':
      return [{
        command: 'erl',
        args: ['-noshell', '-eval', 'io:format("~s", [erlang:system_info(otp_release)]), halt().'],
      }];
    case 'go':
      return [{ command: 'go', args: ['version'], versionPattern: /go version go([0-9A-Za-z.+-]+)/i }];
    case 'gradle':
      return [{ command: 'gradle', args: ['--version'], versionPattern: /Gradle\s+([0-9A-Za-z.+-]+)/i }];
    case 'java':
      return [{ command: 'java', args: ['-version'], versionPattern: /version\s+"([0-9A-Za-z.+-]+)"/i, stream: 'stderr' }];
    case 'maven':
      return [{ command: 'mvn', args: ['--version'], versionPattern: /Apache Maven\s+([0-9A-Za-z.+-]+)/i }];
    case 'node':
      return [{ command: 'node', args: ['--version'] }];
    case 'npm':
      return [{ command: 'npm', args: ['--version'] }];
    case 'pnpm':
      return [{ command: 'pnpm', args: ['--version'] }];
    case 'composer':
      return [{ command: 'composer', args: ['--version'], versionPattern: /Composer version\s+([0-9A-Za-z.+-]+)/i, stream: 'combined' }];
    case 'php':
      return [{ command: 'php', args: ['--version'], versionPattern: /PHP\s+([0-9A-Za-z.+-]+)/i, stream: 'combined' }];
    case 'python':
      return [
        { command: 'python3', args: ['--version'], versionPattern: /Python\s+([0-9A-Za-z.+-]+)/i, stream: 'combined' },
        { command: 'python', args: ['--version'], versionPattern: /Python\s+([0-9A-Za-z.+-]+)/i, stream: 'combined' },
      ];
    case 'ruby':
      return [{ command: 'ruby', args: ['--version'], versionPattern: /ruby\s+([0-9A-Za-z.+-]+)/i }];
    case 'rust':
      return [{ command: 'rustc', args: ['--version'], versionPattern: /rustc\s+([0-9A-Za-z.+-]+)/i }];
    case 'sccache':
      return [{ command: 'sccache', args: ['--version'], versionPattern: /sccache\s+([0-9A-Za-z.+-]+)/i }];
    case 'turbo':
      return [{ command: 'turbo', args: ['--version'] }];
    case 'uv':
      return [{ command: 'uv', args: ['--version'] }];
    case 'yarn':
      return [{ command: 'yarn', args: ['--version'] }];
    default:
      return [];
  }
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

export async function exportMiseEnv(cwd?: string): Promise<void> {
  core.info('Exporting mise environment...');

  const envVars = await readMiseEnvJson(cwd);
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      if (typeof value === 'string') {
        core.exportVariable(key, value);
      }
    }
    return;
  }

  const dotenv = await readMiseEnvDotenv(cwd);
  for (const [key, value] of parseDotenvLines(dotenv)) {
    core.exportVariable(key, value);
  }
}

function buildUseArgs(spec: string, global: boolean): string[] {
  return global ? ['use', '-g', spec] : ['use', spec];
}

async function readMiseEnvJson(cwd?: string): Promise<Record<string, string> | null> {
  let output = '';

  const exitCode = await exec.exec(
    getMiseBinPath(),
    ['env', '--json'],
    {
      cwd,
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString();
        },
      },
    },
  );

  if (exitCode !== 0 || !output.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return null;
  }
}

async function readMiseEnvDotenv(cwd?: string): Promise<string> {
  let output = '';

  const exitCode = await exec.exec(
    getMiseBinPath(),
    ['env', '--dotenv'],
    {
      cwd,
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString();
        },
      },
    },
  );

  if (exitCode !== 0) {
    throw new Error('Failed to export mise environment');
  }

  return output;
}

function parseDotenvLines(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (key) {
      entries.push([key, value]);
    }
  }

  return entries;
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
  const normalized = value.trim().toLowerCase();
  if (normalized === 'nodejs') {
    return 'node';
  }
  if (normalized === 'golang') {
    return 'go';
  }
  return normalized;
}
