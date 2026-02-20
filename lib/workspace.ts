import * as core from '@actions/core';
import * as fs from 'fs';

/**
 * Resolve workspace from input or environment.
 * Used by docker, buildkit, nodejs, rust, ruby actions.
 */
export function getWorkspace(inputWorkspace: string): string {
  let workspace = inputWorkspace || process.env.BORINGCACHE_DEFAULT_WORKSPACE || '';

  if (!workspace) {
    core.setFailed('Workspace is required. Set workspace input or BORINGCACHE_DEFAULT_WORKSPACE env var.');
    throw new Error('Workspace required');
  }

  if (!workspace.includes('/')) {
    workspace = `default/${workspace}`;
  }

  return workspace;
}

/**
 * Resolve cache tag prefix from input or GITHUB_REPOSITORY.
 * Falls back to the provided default (e.g. 'nodejs', 'rust', 'ruby').
 */
export function getCacheTagPrefix(inputCacheTag: string, defaultPrefix: string): string {
  if (inputCacheTag) {
    return inputCacheTag;
  }

  const repo = process.env.GITHUB_REPOSITORY || '';
  if (repo) {
    const repoName = repo.split('/')[1] || repo;
    return repoName;
  }

  return defaultPrefix;
}

/**
 * Async file/directory existence check.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}
