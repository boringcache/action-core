import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const isWindows = process.platform === 'win32';

export interface MiseToolOptions {
  env?: Record<string, string>;
  global?: boolean;
  label?: string;
}

export interface MiseToolVersion {
  name: string;
  version: string;
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
  core.info('Installing mise...');
  if (isWindows) {
    await installMiseWindows();
  } else {
    await exec.exec('sh', ['-c', 'curl https://mise.run | sh']);
  }

  core.addPath(path.dirname(getMiseBinPath()));
  core.addPath(getMiseShimsDir());
}

async function installMiseWindows(): Promise<void> {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const miseVersion = process.env.MISE_VERSION || 'v2026.2.8';
  const url = `https://github.com/jdx/mise/releases/download/${miseVersion}/mise-${miseVersion}-windows-${arch}.zip`;

  const binDir = path.dirname(getMiseBinPath());
  await fs.promises.mkdir(binDir, { recursive: true });

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mise-'));
  try {
    const zipPath = path.join(tempDir, 'mise.zip');
    await exec.exec('curl', ['-fsSL', '-o', zipPath, url]);
    await exec.exec('tar', ['-xf', zipPath, '-C', tempDir]);
    await fs.promises.copyFile(
      path.join(tempDir, 'mise', 'bin', 'mise.exe'),
      getMiseBinPath(),
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
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
