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

export async function installMise(): Promise<void> {
  core.info('Installing mise...');
  if (isWindows) {
    await installMiseWindows();
  } else {
    await exec.exec('sh', ['-c', 'curl https://mise.run | sh']);
  }

  core.addPath(path.dirname(getMiseBinPath()));
  core.addPath(path.join(getMiseDataDir(), 'shims'));
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

function buildUseArgs(spec: string, global: boolean): string[] {
  return global ? ['use', '-g', spec] : ['use', spec];
}

export async function readMiseTomlVersion(workingDir: string, toolName: string): Promise<string | null> {
  const miseToml = path.join(workingDir, 'mise.toml');
  try {
    const content = await fs.promises.readFile(miseToml, 'utf-8');
    const toolsMatch = content.match(/\[tools\]([\s\S]*?)(?:\n\[|$)/);
    if (!toolsMatch) {
      return null;
    }

    const toolsBlock = toolsMatch[1];
    const escapedToolName = escapeRegExp(toolName);
    const stringVersionMatch = toolsBlock.match(
      new RegExp(`^\\s*${escapedToolName}\\s*=\\s*["']([^"']+)["']`, 'm')
    );
    if (stringVersionMatch) {
      return stringVersionMatch[1];
    }

    const tableVersionMatch = toolsBlock.match(
      new RegExp(
        `^\\s*${escapedToolName}\\s*=\\s*\\{[^\\n}]*\\bversion\\s*=\\s*["']([^"']+)["'][^\\n}]*\\}`,
        'm',
      ),
    );
    if (tableVersionMatch) {
      return tableVersionMatch[1];
    }
  } catch {}

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
