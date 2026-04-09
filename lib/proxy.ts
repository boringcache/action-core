import * as core from '@actions/core';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import {
  getAuthTokens,
  missingRestoreTokenMessage,
  missingSaveTokenMessage,
  warnIfUsingLegacyApiToken,
} from './auth';

export interface ProxyOptions {
  command: 'cache-registry' | 'docker-registry';
  workspace: string;
  tag: string;
  host?: string;
  port: number;
  noGit?: boolean;
  noPlatform?: boolean;
  verbose?: boolean;
  readOnly?: boolean;
}

export interface ProxyHandle {
  pid: number;
  port: number;
  readOnly: boolean;
}

const PROXY_PID_FILE = path.join(os.tmpdir(), 'boringcache-proxy.pid');
const PROXY_PREFETCH_STATE_HEADER = 'x-boringcache-prefetch-state';
const PROXY_PREFETCH_STATE_READY = 'ready';
const PROXY_PREFETCH_STATE_WARMING = 'warming';

export function normalizeProxyTags(tagInput: string): string {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const rawTag of tagInput.split(',')) {
    const tag = rawTag.trim();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }

  if (tags.length === 0) {
    throw new Error('At least one proxy tag is required');
  }

  return tags.join(',');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function proxyLogPath(port: number): string {
  return path.join(os.tmpdir(), `boringcache-proxy-${port}.log`);
}

function readProxyLogs(port: number): string {
  try {
    return fs.readFileSync(proxyLogPath(port), 'utf-8').trim();
  } catch {
    return '';
  }
}

async function isProxyRunning(port: number): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/v2/`, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 401);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

interface ProxyReadinessProbe {
  ready: boolean;
  state: string | null;
}

async function probeProxyReadiness(port: number): Promise<ProxyReadinessProbe> {
  try {
    return await new Promise<ProxyReadinessProbe>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/v2/`, (res) => {
        const header = res.headers[PROXY_PREFETCH_STATE_HEADER];
        const state = Array.isArray(header) ? header[0] ?? null : header ?? null;
        res.resume();

        if (res.statusCode === 401) {
          resolve({ ready: true, state: 'unauthorized' });
          return;
        }

        if (res.statusCode === 200) {
          if (!state) {
            resolve({ ready: true, state: null });
            return;
          }
          resolve({
            ready: state.toLowerCase() === PROXY_PREFETCH_STATE_READY,
            state,
          });
          return;
        }

        resolve({ ready: false, state });
      });
      req.on('error', () => resolve({ ready: false, state: null }));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve({ ready: false, state: null });
      });
    });
  } catch {
    return { ready: false, state: null };
  }
}

/**
 * Start a registry proxy (docker-registry or cache-registry).
 * Spawns a detached boringcache process, writes PID file, returns handle.
 */
export async function startRegistryProxy(options: ProxyOptions): Promise<ProxyHandle> {
  warnIfUsingLegacyApiToken();
  const { restoreToken, saveToken } = getAuthTokens();

  let effectiveReadOnly = options.readOnly === true;
  let authToken = effectiveReadOnly ? restoreToken : saveToken;

  if (!authToken && !effectiveReadOnly && options.command === 'cache-registry' && restoreToken) {
    effectiveReadOnly = true;
    authToken = restoreToken;
    core.info(
      'No save-capable token configured; starting cache-registry in read-only mode with BORINGCACHE_RESTORE_TOKEN'
    );
  }

  if (!authToken) {
    if (effectiveReadOnly) {
      throw new Error(`${missingRestoreTokenMessage()} This is required for registry proxy mode.`);
    }
    throw new Error(`${missingSaveTokenMessage()} This is required for registry proxy mode.`);
  }

  const host = options.host || '127.0.0.1';
  const normalizedTags = normalizeProxyTags(options.tag);
  const tagList = normalizedTags.split(',');
  const primaryTag = tagList[0];

  if (await isProxyRunning(options.port)) {
    core.info(`Registry proxy already running on port ${options.port}, reusing`);
    try {
      const pid = parseInt(fs.readFileSync(PROXY_PID_FILE, 'utf-8').trim(), 10);
      if (pid > 0) return { pid, port: options.port, readOnly: effectiveReadOnly };
    } catch {}
    return { pid: -1, port: options.port, readOnly: effectiveReadOnly };
  }

  const args = [options.command, options.workspace, normalizedTags];
  if (options.noGit) {
    args.push('--no-git');
  }
  if (options.noPlatform) {
    args.push('--no-platform');
  }
  args.push('--host', host, '--port', String(options.port));
  if (effectiveReadOnly) {
    args.push('--read-only');
  }
  if (options.verbose) {
    args.push('--verbose');
  }

  core.info(`Starting registry proxy on ${host}:${options.port}...`);
  core.info(`Registry proxy primary tag: ${primaryTag}`);
  if (tagList.length > 1) {
    core.info(`Registry proxy alias tags: ${tagList.slice(1).join(', ')}`);
  }
  if (effectiveReadOnly) {
    core.info('Registry proxy mode: read-only');
  }

  const logFile = proxyLogPath(options.port);
  const logFd = fs.openSync(logFile, 'w');
  const child: ChildProcess = spawn('boringcache', args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      BORINGCACHE_API_TOKEN: authToken,
    }
  });

  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error('Failed to start registry proxy');
  }

  fs.writeFileSync(PROXY_PID_FILE, String(child.pid));
  core.info(`Registry proxy started (PID: ${child.pid})`);
  return { pid: child.pid, port: options.port, readOnly: effectiveReadOnly };
}

/**
 * Poll /v2/ until proxy is ready. Checks that the process is still alive.
 */
export async function waitForProxy(port: number, timeoutMs = 300000, pid?: number): Promise<void> {
  const start = Date.now();
  const interval = 500;
  let lastLogAt = 0;
  let lastState: string | null = null;

  while (Date.now() - start < timeoutMs) {
    if (pid && pid > 0 && !isProcessAlive(pid)) {
      const logs = readProxyLogs(port);
      throw new Error(`Registry proxy exited before becoming ready${logs ? `:\n${logs}` : ''}`);
    }

    try {
      const probe = await probeProxyReadiness(port);
      lastState = probe.state;
      if (probe.ready) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        core.info(`Registry proxy is ready (${elapsed}s)`);
        return;
      }
    } catch {
    }

    const elapsed = Date.now() - start;
    if (elapsed - lastLogAt >= 10000) {
      const suffix = lastState?.toLowerCase() === PROXY_PREFETCH_STATE_WARMING
        ? ', prefetch warming'
        : '';
      core.info(`Waiting for proxy readiness... (${(elapsed / 1000).toFixed(0)}s${suffix})`);
      lastLogAt = elapsed;
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  const logs = readProxyLogs(port);
  throw new Error(`Registry proxy did not become ready within ${timeoutMs}ms${logs ? `:\n${logs}` : ''}`);
}

/**
 * Graceful stop: send SIGTERM and wait for the proxy to exit on its own.
 * The proxy handles SIGTERM by flushing all pending blobs to the backend,
 * then exits. Never send SIGKILL — the proxy owns its own shutdown timing.
 */
export async function stopRegistryProxy(pid: number): Promise<void> {
  if (pid <= 0) {
    core.info('No proxy PID to stop (was reused from another invocation)');
    return;
  }

  core.info(`Stopping registry proxy (PID: ${pid})...`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      core.info(`Registry proxy (PID: ${pid}) already exited`);
      return;
    }
    core.warning(`Failed to send SIGTERM to registry proxy: ${(err as Error).message}`);
    return;
  }

  const start = Date.now();
  const pollInterval = 1000;
  const logInterval = 30_000;
  let lastLog = start;
  while (true) {
    if (!isProcessAlive(pid)) {
      core.info(`Registry proxy exited gracefully after ${Math.round((Date.now() - start) / 1000)}s`);
      return;
    }
    const now = Date.now();
    if (now - lastLog >= logInterval) {
      core.info(`Waiting for registry proxy to flush and exit... (${Math.round((now - start) / 1000)}s elapsed)`);
      lastLog = now;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

/**
 * Bind to port 0 and return the assigned port.
 */
export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}
