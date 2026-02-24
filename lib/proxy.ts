import * as core from '@actions/core';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

export interface ProxyOptions {
  command: 'cache-registry' | 'docker-registry';
  workspace: string;
  tag: string;
  host?: string;
  port: number;
  noGit?: boolean;
  noPlatform?: boolean;
  verbose?: boolean;
}

export interface ProxyHandle {
  pid: number;
  port: number;
}

const PROXY_LOG_FILE = path.join(os.tmpdir(), 'boringcache-proxy.log');
const PROXY_PID_FILE = path.join(os.tmpdir(), 'boringcache-proxy.pid');

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

function readProxyLogs(): string {
  try {
    return fs.readFileSync(PROXY_LOG_FILE, 'utf-8').trim();
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

/**
 * Start a registry proxy (docker-registry or cache-registry).
 * Spawns a detached boringcache process, writes PID file, returns handle.
 */
export async function startRegistryProxy(options: ProxyOptions): Promise<ProxyHandle> {
  if (!process.env.BORINGCACHE_API_TOKEN) {
    throw new Error('BORINGCACHE_API_TOKEN is required for registry proxy mode');
  }

  const host = options.host || '127.0.0.1';
  const normalizedTags = normalizeProxyTags(options.tag);
  const tagList = normalizedTags.split(',');
  const primaryTag = tagList[0];

  if (await isProxyRunning(options.port)) {
    core.info(`Registry proxy already running on port ${options.port}, reusing`);
    try {
      const pid = parseInt(fs.readFileSync(PROXY_PID_FILE, 'utf-8').trim(), 10);
      if (pid > 0) return { pid, port: options.port };
    } catch {}
    return { pid: -1, port: options.port };
  }

  const args = [options.command, options.workspace, normalizedTags];
  if (options.noGit) {
    args.push('--no-git');
  }
  if (options.noPlatform) {
    args.push('--no-platform');
  }
  args.push('--host', host, '--port', String(options.port));
  if (options.verbose) {
    args.push('--verbose');
  }

  core.info(`Starting registry proxy on ${host}:${options.port}...`);
  core.info(`Registry proxy primary tag: ${primaryTag}`);
  if (tagList.length > 1) {
    core.info(`Registry proxy alias tags: ${tagList.slice(1).join(', ')}`);
  }

  const logFile = path.join(os.tmpdir(), `boringcache-proxy-${options.port}.log`);
  const logFd = fs.openSync(logFile, 'w');
  const child: ChildProcess = spawn('boringcache', args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env
  });

  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error('Failed to start registry proxy');
  }

  fs.writeFileSync(PROXY_PID_FILE, String(child.pid));
  core.info(`Registry proxy started (PID: ${child.pid})`);
  return { pid: child.pid, port: options.port };
}

/**
 * Poll /v2/ until proxy is ready. Checks that the process is still alive.
 */
export async function waitForProxy(port: number, timeoutMs = 20000, pid?: number): Promise<void> {
  const start = Date.now();
  const interval = 500;

  while (Date.now() - start < timeoutMs) {
    if (pid && pid > 0 && !isProcessAlive(pid)) {
      const logs = readProxyLogs();
      throw new Error(`Registry proxy exited before becoming ready${logs ? `:\n${logs}` : ''}`);
    }

    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/v2/`, (res) => {
          resolve(res.statusCode === 200 || res.statusCode === 401);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) {
        core.info('Registry proxy is ready');
        return;
      }
    } catch {
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  const logs = readProxyLogs();
  throw new Error(`Registry proxy did not become ready within ${timeoutMs}ms${logs ? `:\n${logs}` : ''}`);
}

/**
 * Graceful stop: SIGTERM, wait 2s, SIGKILL if still alive.
 */
export async function stopRegistryProxy(pid: number): Promise<void> {
  if (pid <= 0) {
    core.info('No proxy PID to stop (was reused from another invocation)');
    return;
  }
  core.info(`Stopping registry proxy (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
    }
    core.info('Registry proxy stopped');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      core.info(`Registry proxy (PID: ${pid}) already exited`);
    } else {
      core.warning(`Failed to stop registry proxy: ${(err as Error).message}`);
    }
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
