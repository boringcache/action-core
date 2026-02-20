import * as core from '@actions/core';
import * as os from 'os';
import * as path from 'path';

export interface CacheConfig {
  workspace: string;
  fullKey: string;
  platformSuffix: string;
}

export interface CacheEntry {
  tag: string;
  restorePath: string;
  savePath: string;
}

interface ParseEntryOptions {
  resolvePaths?: boolean;
}

export async function getCacheConfig(
  key: string,
  enableCrossOsArchive: boolean,
  noPlatform: boolean = false
): Promise<CacheConfig> {
  let workspace =
    process.env.BORINGCACHE_DEFAULT_WORKSPACE ||
    process.env.GITHUB_REPOSITORY ||
    'default/default';

  if (!workspace.includes('/')) {
    workspace = `default/${workspace}`;
  }

  let platformSuffix = '';
  if (!noPlatform && !enableCrossOsArchive) {
    const platform = os.platform() === 'darwin' ? 'darwin' : os.platform() === 'win32' ? 'windows' : 'linux';
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    platformSuffix = `-${platform}-${arch}`;
  }

  const fullKey = key + platformSuffix;

  return { workspace, fullKey, platformSuffix };
}

export function validateInputs(inputs: Record<string, unknown>): void {
  const hasCliFormat = inputs.workspace || inputs.entries;
  const hasCacheFormat = inputs.path || inputs.key;

  if (!hasCliFormat && !hasCacheFormat) {
    throw new Error('Either (workspace + entries) or (path + key) inputs are required');
  }

  if (hasCliFormat && hasCacheFormat) {
    core.warning('Both CLI format (workspace/entries) and actions/cache format (path/key) provided. Using CLI format.');
  }

  if (hasCliFormat && !inputs.entries) {
    throw new Error('Input "entries" is required when using CLI format');
  }

  if (hasCacheFormat && !hasCliFormat) {
    if (!inputs.path) {
      throw new Error('Input "path" is required when using actions/cache format');
    }
    if (!inputs.key) {
      throw new Error('Input "key" is required when using actions/cache format');
    }
  }

  if (inputs.workspace && typeof inputs.workspace === 'string' && !inputs.workspace.includes('/')) {
    throw new Error('Workspace must be in format "namespace/workspace" (e.g., "my-org/my-project")');
  }
}

export function resolvePath(pathInput: string): string {
  const trimmedPath = pathInput.trim();

  if (path.isAbsolute(trimmedPath)) {
    return trimmedPath;
  }

  if (trimmedPath.startsWith('~/')) {
    return path.join(os.homedir(), trimmedPath.slice(2));
  }

  return path.resolve(process.cwd(), trimmedPath);
}

export function resolvePaths(pathInput: string): string {
  return pathInput
    .split('\n')
    .map(p => p.trim())
    .filter(p => p)
    .map(p => resolvePath(p))
    .join('\n');
}

export function parseEntries(
  entriesInput: string,
  _action: 'save' | 'restore',
  options: ParseEntryOptions = {}
): CacheEntry[] {
  const shouldResolve = options.resolvePaths ?? true;

  return entriesInput
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry)
    .map(entry => {
      const colonIndex = entry.indexOf(':');

      if (colonIndex === -1) {
        throw new Error(`Invalid entry format: ${entry}. Expected format: tag:path or tag:restore_path=>save_path`);
      }

      const tag = entry.substring(0, colonIndex).trim();
      const pathSpec = entry.substring(colonIndex + 1).trim();

      if (!tag) {
        throw new Error(`Invalid entry format: ${entry}. Tag cannot be empty`);
      }

      let restorePathInput = pathSpec;
      let savePathInput = pathSpec;

      const redirectIndex = pathSpec.indexOf('=>');
      if (redirectIndex !== -1) {
        restorePathInput = pathSpec.substring(0, redirectIndex).trim();
        savePathInput = pathSpec.substring(redirectIndex + 2).trim();

        if (!restorePathInput || !savePathInput) {
          throw new Error(`Invalid entry format: ${entry}. Expected restore and save paths when using => syntax`);
        }
      }

      const restorePath = shouldResolve ? resolvePath(restorePathInput) : restorePathInput;
      const savePath = shouldResolve ? resolvePath(savePathInput) : savePathInput;

      return { tag, restorePath, savePath };
    });
}

export function getPlatformSuffix(noPlatform: boolean, enableCrossOsArchive: boolean): string {
  if (noPlatform || enableCrossOsArchive) {
    return '';
  }

  const platform = os.platform() === 'darwin' ? 'darwin' : os.platform() === 'win32' ? 'windows' : 'linux';
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  return `-${platform}-${arch}`;
}

/**
 * Get workspace from action inputs (Record-based).
 * Used by the generic action/save/restore actions.
 * NOTE: This is different from workspace.ts getWorkspace which takes a string.
 */
export function getInputsWorkspace(inputs: Record<string, unknown>): string {
  if (inputs.workspace && typeof inputs.workspace === 'string') {
    return inputs.workspace;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    const parts = repo.split('/');
    return `${parts[0]}/${parts[1]}`;
  }

  return 'default/default';
}

export function convertCacheFormatToEntries(
  inputs: Record<string, unknown>,
  _action: 'save' | 'restore'
): string {
  if (!inputs.path || !inputs.key) {
    throw new Error('actions/cache format requires both path and key inputs');
  }

  const pathInput = inputs.path as string;
  const keyInput = inputs.key as string;
  const noPlatformInput = inputs.noPlatform as boolean | undefined;
  const enableCrossOsArchiveInput = inputs.enableCrossOsArchive as boolean | undefined;

  const paths = pathInput
    .split('\n')
    .map(p => p.trim())
    .filter(p => p);

  const shouldDisablePlatform = noPlatformInput || enableCrossOsArchiveInput || false;
  const platformSuffix = getPlatformSuffix(shouldDisablePlatform, enableCrossOsArchiveInput || false);
  const fullKey = keyInput + platformSuffix;

  return paths.map(p => `${fullKey}:${resolvePath(p)}`).join(',');
}
