import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  normalizeProxyTags,
  startRegistryProxy,
  stopRegistryProxy,
} from '../lib/proxy';

const PROXY_PID_FILE = path.join(os.tmpdir(), 'boringcache-proxy.pid');
const PROXY_READY_FILE = (port: number) => path.join(os.tmpdir(), `boringcache-proxy-${port}.ready`);
const PROXY_LOG_FILE = (port: number) => path.join(os.tmpdir(), `boringcache-proxy-${port}.log`);

async function findTestPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        const resolvedPort = address.port;
        server.close((error) => (error ? reject(error) : resolve(resolvedPort)));
      } else {
        server.close(() => reject(new Error('failed to bind probe port')));
      }
    });
    server.on('error', reject);
  });
}

function cleanupProxyArtifacts(port: number): void {
  for (const filePath of [PROXY_LOG_FILE(port), PROXY_READY_FILE(port)]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore missing temp files from tests.
    }
  }
}

describe('normalizeProxyTags', () => {
  it('keeps a single human tag unchanged', () => {
    expect(normalizeProxyTags('hugo-docker-build')).toBe('hugo-docker-build');
  });

  it('trims whitespace and preserves tag order', () => {
    expect(normalizeProxyTags('tag1, tag2 ,tag3')).toBe('tag1,tag2,tag3');
  });

  it('deduplicates repeated tags', () => {
    expect(normalizeProxyTags('tag1,tag2,tag1,tag2,tag3')).toBe('tag1,tag2,tag3');
  });

  it('rejects empty tag input', () => {
    expect(() => normalizeProxyTags(' , , ')).toThrow(
      'At least one proxy tag is required'
    );
  });
});

describe('startRegistryProxy readiness orchestration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    try {
      fs.unlinkSync(PROXY_PID_FILE);
    } catch {
      // Ignore missing temp files from tests.
    }
  });

  it('waits for proxy readiness before returning from startRegistryProxy', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'action-core-proxy-bin-'));
    const binDir = path.join(tempRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const boringcachePath = path.join(binDir, 'boringcache');
    fs.writeFileSync(
      boringcachePath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
let readyFile = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--ready-file') {
    readyFile = args[i + 1];
    i += 1;
  }
}

const readyAt = Date.now() + 1200;
const keepAlive = setInterval(() => {}, 1000);
const readyTimer = setTimeout(() => {
  if (readyFile) {
    require('fs').writeFileSync(readyFile, 'ready\\n');
  }
}, Math.max(0, readyAt - Date.now()));

process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  clearTimeout(readyTimer);
  process.exit(0);
});
`,
      { mode: 0o755 }
    );

    const originalPath = process.env.PATH;
    const originalSaveToken = process.env.BORINGCACHE_SAVE_TOKEN;
    const originalRestoreToken = process.env.BORINGCACHE_RESTORE_TOKEN;
    const originalApiToken = process.env.BORINGCACHE_API_TOKEN;

    const port = await findTestPort();

    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ''}`;
    process.env.BORINGCACHE_SAVE_TOKEN = 'test-save-token';
    delete process.env.BORINGCACHE_RESTORE_TOKEN;
    delete process.env.BORINGCACHE_API_TOKEN;

    try {
      const startedAt = Date.now();
      const proxy = await startRegistryProxy({
        command: 'cache-registry',
        workspace: 'org/repo',
        tag: 'integration-proxy',
        port,
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(fs.existsSync(PROXY_READY_FILE(port))).toBe(false);

      await stopRegistryProxy(proxy.pid);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalSaveToken === undefined) {
        delete process.env.BORINGCACHE_SAVE_TOKEN;
      } else {
        process.env.BORINGCACHE_SAVE_TOKEN = originalSaveToken;
      }
      if (originalRestoreToken === undefined) {
        delete process.env.BORINGCACHE_RESTORE_TOKEN;
      } else {
        process.env.BORINGCACHE_RESTORE_TOKEN = originalRestoreToken;
      }
      if (originalApiToken === undefined) {
        delete process.env.BORINGCACHE_API_TOKEN;
      } else {
        process.env.BORINGCACHE_API_TOKEN = originalApiToken;
      }
      cleanupProxyArtifacts(port);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reads the per-port proxy log when the proxy exits before readiness', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'action-core-proxy-bin-fail-'));
    const binDir = path.join(tempRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const boringcachePath = path.join(binDir, 'boringcache');
    fs.writeFileSync(
      boringcachePath,
      `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let port = 5000;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--port') {
    port = Number(args[i + 1]);
    i += 1;
  }
}
fs.writeFileSync(require('path').join(require('os').tmpdir(), 'boringcache-proxy-' + port + '.log'), 'port-specific log');
process.exit(1);
`,
      { mode: 0o755 }
    );

    const originalPath = process.env.PATH;
    const originalSaveToken = process.env.BORINGCACHE_SAVE_TOKEN;
    const originalRestoreToken = process.env.BORINGCACHE_RESTORE_TOKEN;
    const originalApiToken = process.env.BORINGCACHE_API_TOKEN;
    const port = await findTestPort();
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ''}`;
    process.env.BORINGCACHE_SAVE_TOKEN = 'test-save-token';
    delete process.env.BORINGCACHE_RESTORE_TOKEN;
    delete process.env.BORINGCACHE_API_TOKEN;

    try {
      await expect(startRegistryProxy({
        command: 'cache-registry',
        workspace: 'org/repo',
        tag: 'integration-proxy',
        port,
      })).rejects.toThrow('port-specific log');
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalSaveToken === undefined) {
        delete process.env.BORINGCACHE_SAVE_TOKEN;
      } else {
        process.env.BORINGCACHE_SAVE_TOKEN = originalSaveToken;
      }
      if (originalRestoreToken === undefined) {
        delete process.env.BORINGCACHE_RESTORE_TOKEN;
      } else {
        process.env.BORINGCACHE_RESTORE_TOKEN = originalRestoreToken;
      }
      if (originalApiToken === undefined) {
        delete process.env.BORINGCACHE_API_TOKEN;
      } else {
        process.env.BORINGCACHE_API_TOKEN = originalApiToken;
      }
      cleanupProxyArtifacts(port);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
