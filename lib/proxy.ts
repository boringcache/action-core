import * as core from '@actions/core';
import * as fs from 'fs';
import * as net from 'net';
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
  command: 'cache-registry';
  workspace: string;
  tag: string;
  host?: string;
  port: number;
  noGit?: boolean;
  noPlatform?: boolean;
  verbose?: boolean;
  readOnly?: boolean;
  onDemand?: boolean;
}

export interface ProxyHandle {
  pid: number;
  port: number;
  readOnly: boolean;
}

const PROXY_PID_FILE = path.join(os.tmpdir(), 'boringcache-proxy.pid');
const PROXY_READY_TIMEOUT_MS = 300000;
const PROXY_READY_POLL_INTERVAL_MS = 200;
const PROXY_READY_WARN_INTERVAL_MS = 10000;

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

function proxyProbeHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

async function isProxyRunning(host: string, port: number): Promise<boolean> {
  const probeHost = proxyProbeHost(host);
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: probeHost, port });
    let settled = false;

    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function proxyReadyFilePath(port: number): string {
  return path.join(os.tmpdir(), `boringcache-proxy-${port}.ready`);
}

function clearProxyReadyFile(readyFile: string): void {
  try {
    fs.unlinkSync(readyFile);
  } catch {
    // Ignore missing or inaccessible ready markers; startup will recreate them.
  }
}

async function waitForProxyReadyFile(
  readyFile: string,
  timeoutMs = PROXY_READY_TIMEOUT_MS,
  port?: number,
  pid?: number,
): Promise<void> {
  const start = Date.now();
  let lastLogAt = 0;

  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(readyFile)) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      core.info(`Registry proxy is ready (${elapsed}s)`);
      clearProxyReadyFile(readyFile);
      return;
    }

    if (pid && pid > 0 && !isProcessAlive(pid)) {
      const logs = port ? readProxyLogs(port) : '';
      throw new Error(`Registry proxy exited before becoming ready${logs ? `:\n${logs}` : ''}`);
    }

    const elapsed = Date.now() - start;
    if (elapsed - lastLogAt >= PROXY_READY_WARN_INTERVAL_MS) {
      core.info(`Waiting for proxy readiness... (${(elapsed / 1000).toFixed(0)}s)`);
      lastLogAt = elapsed;
    }

    await new Promise((resolve) => setTimeout(resolve, PROXY_READY_POLL_INTERVAL_MS));
  }

  const logs = port ? readProxyLogs(port) : '';
  throw new Error(`Registry proxy did not become ready within ${timeoutMs}ms${logs ? `:\n${logs}` : ''}`);
}

/**
 * Start the cache-registry proxy.
 * Spawns a detached boringcache process, writes PID file, returns handle.
 */
export async function startRegistryProxy(options: ProxyOptions): Promise<ProxyHandle> {
  warnIfUsingLegacyApiToken();
  const { restoreToken, saveToken } = getAuthTokens();

  let effectiveReadOnly = options.readOnly === true;
  let authToken = effectiveReadOnly ? restoreToken : saveToken;

  if (!authToken && !effectiveReadOnly && restoreToken) {
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
  const cliCommand = 'cache-registry';
  const normalizedTags = normalizeProxyTags(options.tag);
  const tagList = normalizedTags.split(',');
  const primaryTag = tagList[0];
  const readyFile = proxyReadyFilePath(options.port);

  if (await isProxyRunning(host, options.port)) {
    core.info(`Registry proxy already running on port ${options.port}, reusing`);
    try {
      const pid = parseInt(fs.readFileSync(PROXY_PID_FILE, 'utf-8').trim(), 10);
      if (pid > 0) return { pid, port: options.port, readOnly: effectiveReadOnly };
    } catch {}
    return { pid: -1, port: options.port, readOnly: effectiveReadOnly };
  }

  clearProxyReadyFile(readyFile);

  const args = [cliCommand, options.workspace, normalizedTags];
  if (options.noGit) {
    args.push('--no-git');
  }
  if (options.noPlatform) {
    args.push('--no-platform');
  }
  args.push('--host', host, '--port', String(options.port));
  args.push('--ready-file', readyFile);
  if (options.onDemand) {
    args.push('--on-demand');
  }
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
  if (options.onDemand) {
    core.info('Registry proxy startup: on-demand');
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
  const handle = { pid: child.pid, port: options.port, readOnly: effectiveReadOnly };

  try {
    await waitForProxyReadyFile(readyFile, PROXY_READY_TIMEOUT_MS, options.port, child.pid);
    return handle;
  } catch (error) {
    try {
      await stopRegistryProxy(child.pid);
    } catch {
      // Keep the original readiness failure as the primary error.
    }
    clearProxyReadyFile(readyFile);
    throw error;
  }
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
