import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/tool-cache');
jest.mock('@actions/cache');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    ...jest.requireActual('fs').promises,
    readFile: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    mkdtemp: jest.fn().mockResolvedValue('/tmp/mise-123'),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
  },
}));

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as tc from '@actions/tool-cache';
import {
  activateMiseTool,
  buildMiseRuntimeTag,
  buildMiseToolTag,
  exportMiseEnv,
  getMiseBinPath,
  getMiseDataDir,
  getMiseInstallsDir,
  getMiseShimsDir,
  hasMiseToolVersion,
  hasToolVersionOnPath,
  installMise,
  installMiseTool,
  readMiseTomlTools,
  readMiseTomlVersion,
  readProjectMiseTools,
  readToolVersions,
  readToolVersionsValue,
  reshimMise,
  scopeMiseToolVersion,
  slugMiseTagPart,
} from '../lib/mise';

const MOCK_BINARY_CONTENT = Buffer.from('mock-mise-binary');
const MOCK_BINARY_HASH = crypto.createHash('sha256').update(MOCK_BINARY_CONTENT).digest('hex');
const SAMPLE_SHASUMS256 = `${MOCK_BINARY_HASH}  mise-v2026.3.8-linux-x64
${MOCK_BINARY_HASH}  mise-v2026.3.8-linux-arm64
${MOCK_BINARY_HASH}  mise-v2026.3.8-macos-arm64
${MOCK_BINARY_HASH}  mise-v2026.3.8-macos-x64
${MOCK_BINARY_HASH}  mise-v2026.3.8-windows-x64.zip
`;

const originalEnv = process.env;
const mockedCore = jest.mocked(core);
const mockedExec = jest.mocked(exec);
const mockedCache = jest.mocked(cache);
const mockedFs = jest.mocked(fs);
const mockedTc = jest.mocked(tc);

describe('mise helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MISE_VERSION;
    delete process.env.RUNNER_OS;
    delete process.env.RUNNER_ARCH;
    delete process.env.RUNNER_TOOL_CACHE;

    mockedCache.restoreCache.mockResolvedValue(undefined);
    mockedCache.saveCache.mockResolvedValue(1);
    mockedTc.find.mockReturnValue('');
    mockedTc.cacheDir.mockResolvedValue('/tmp/mise-tool-cache');
    mockedTc.extractZip.mockResolvedValue('/tmp/mise-extracted');
    mockedTc.downloadTool.mockImplementation(async (url: string) => {
      if (url.endsWith('SHASUMS256.txt')) {
        return '/tmp/SHASUMS256.txt';
      }
      return '/tmp/mise-download';
    });
    mockedFs.promises.readFile.mockImplementation((filePath: fs.PathLike | unknown, options?: unknown) => {
      if (options === 'utf-8' || String(filePath).includes('SHASUMS256')) {
        return Promise.resolve(SAMPLE_SHASUMS256);
      }
      return Promise.resolve(MOCK_BINARY_CONTENT);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the platform-specific mise binary path', () => {
    const homedir = os.homedir();
    expect(getMiseBinPath()).toBe(
      process.platform === 'win32'
        ? path.join(homedir, '.local', 'bin', 'mise.exe')
        : path.join(homedir, '.local', 'bin', 'mise'),
    );
  });

  it('returns the platform-specific mise data directory', () => {
    if (process.platform === 'win32') {
      expect(getMiseDataDir()).toContain('mise');
      return;
    }

    expect(getMiseDataDir()).toBe(path.join(os.homedir(), '.local', 'share', 'mise'));
  });

  it('returns the installs and shims directories derived from the mise data directory', () => {
    expect(getMiseInstallsDir()).toBe(path.join(getMiseDataDir(), 'installs'));
    expect(getMiseShimsDir()).toBe(path.join(getMiseDataDir(), 'shims'));
  });

  it('builds readable mise runtime tags', () => {
    expect(buildMiseRuntimeTag('web', [
      { name: 'ruby', version: '4.0.1' },
      { name: 'pnpm', version: '9.15.1' },
    ])).toBe('web-mise-pnpm-9.15.1-ruby-4.0.1');
  });

  it('supports scoped version tags for deterministic reuse', () => {
    expect(buildMiseToolTag([
      { name: 'ruby', version: '4.0.1' },
      { name: 'node', version: '22.4.1' },
    ], 'minor')).toBe('node-22.4-ruby-4.0');
    expect(scopeMiseToolVersion('4.0.1', 'major')).toBe('4');
  });

  it('slugifies non-semver mise versions safely', () => {
    expect(scopeMiseToolVersion('nightly-2026-03-12', 'patch')).toBe('nightly-2026-03-12');
    expect(slugMiseTagPart(' Ruby 4.0.1 ')).toBe('ruby-4.0.1');
  });

  it('installs mise and adds the bin and shims directories to PATH', async () => {
    process.env.RUNNER_OS = 'Linux';
    process.env.RUNNER_ARCH = 'X64';

    await installMise();

    expect(mockedTc.downloadTool).toHaveBeenNthCalledWith(
      1,
      'https://github.com/jdx/mise/releases/download/v2026.3.8/mise-v2026.3.8-linux-x64',
    );
    expect(mockedTc.downloadTool).toHaveBeenNthCalledWith(
      2,
      'https://github.com/jdx/mise/releases/download/v2026.3.8/SHASUMS256.txt',
    );
    expect(mockedCache.restoreCache).toHaveBeenCalledWith(
      [expect.stringContaining('/mise')],
      'mise-2026.3.8-linux-x64',
    );
    expect(mockedCache.saveCache).toHaveBeenCalledWith(
      [expect.stringContaining('/mise')],
      'mise-2026.3.8-linux-x64',
    );
    expect(mockedTc.cacheDir).toHaveBeenCalled();
    expect(mockedFs.promises.copyFile).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/mise-tool-cache/mise'),
      getMiseBinPath(),
    );
    expect(mockedFs.promises.chmod).toHaveBeenCalledWith(getMiseBinPath(), 0o755);
    expect(mockedCore.addPath).toHaveBeenCalledWith('/tmp/mise-tool-cache');
    expect(mockedCore.addPath).toHaveBeenCalledWith(path.dirname(getMiseBinPath()));
    expect(mockedCore.addPath).toHaveBeenCalledWith(getMiseShimsDir());
  });

  it('uses cached mise when restoreCache repopulates the runner tool cache', async () => {
    process.env.RUNNER_OS = 'Linux';
    process.env.RUNNER_ARCH = 'X64';

    mockedCache.restoreCache.mockResolvedValue('mise-2026.3.8-linux-x64');
    mockedTc.find.mockReturnValue('/tmp/cached-mise');

    await installMise();

    expect(mockedTc.downloadTool).not.toHaveBeenCalled();
    expect(mockedCache.saveCache).not.toHaveBeenCalled();
    expect(mockedFs.promises.copyFile).toHaveBeenCalledWith('/tmp/cached-mise/mise', getMiseBinPath());
    expect(mockedCore.addPath).toHaveBeenCalledWith('/tmp/cached-mise');
  });

  it('honors MISE_VERSION overrides with a pinned release asset', async () => {
    process.env.RUNNER_OS = 'Linux';
    process.env.RUNNER_ARCH = 'X64';
    process.env.MISE_VERSION = '2026.4.1';

    mockedFs.promises.readFile.mockImplementation((filePath: fs.PathLike | unknown, options?: unknown) => {
      if (options === 'utf-8' || String(filePath).includes('SHASUMS256')) {
        return Promise.resolve(`${MOCK_BINARY_HASH}  mise-v2026.4.1-linux-x64\n`);
      }
      return Promise.resolve(MOCK_BINARY_CONTENT);
    });

    await installMise();

    expect(mockedTc.downloadTool).toHaveBeenNthCalledWith(
      1,
      'https://github.com/jdx/mise/releases/download/v2026.4.1/mise-v2026.4.1-linux-x64',
    );
  });

  it('installs and activates a mise-managed tool', async () => {
    const env = { ...process.env, MISE_PYTHON_COMPILE: '0' } as Record<string, string>;

    await installMiseTool('python', '3.12', { env, label: 'Python' });

    expect(mockedCore.info).toHaveBeenCalledWith('Installing Python 3.12 via mise...');
    expect(mockedExec.exec).toHaveBeenNthCalledWith(
      1,
      getMiseBinPath(),
      ['install', 'python@3.12'],
      { env },
    );
    expect(mockedExec.exec).toHaveBeenNthCalledWith(
      2,
      getMiseBinPath(),
      ['use', '-g', 'python@3.12'],
      { env },
    );
  });

  it('activates an already-installed mise-managed tool', async () => {
    await activateMiseTool('node', '22', { label: 'Node.js' });

    expect(mockedCore.info).toHaveBeenCalledWith('Activating Node.js 22...');
    expect(mockedExec.exec).toHaveBeenCalledWith(
      getMiseBinPath(),
      ['use', '-g', 'node@22'],
      { env: undefined },
    );
  });

  it('detects matching installed mise tool versions from mise ls json', async () => {
    mockedExec.exec.mockImplementationOnce(async (_command, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from(JSON.stringify([
        { version: '4.0.1-boringcache', installed: true },
        { version: '4.0.0', installed: true },
      ])));
      return 0;
    });

    await expect(hasMiseToolVersion('ruby', '4.0.1')).resolves.toBe(true);
    expect(mockedExec.exec).toHaveBeenCalledWith(
      getMiseBinPath(),
      ['ls', 'ruby', '--installed', '--json'],
      expect.objectContaining({ ignoreReturnCode: true, silent: true }),
    );
  });

  it('ignores unavailable mise entries when checking installed versions', async () => {
    mockedExec.exec.mockImplementationOnce(async (_command, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from(JSON.stringify([
        { version: '22.4.1', installed: false },
      ])));
      return 0;
    });

    await expect(hasMiseToolVersion('node', '22.4.1')).resolves.toBe(false);
  });

  it('detects matching versions from tools already on PATH', async () => {
    mockedExec.exec.mockImplementationOnce(async (_command, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from('v22.4.1\n'));
      return 0;
    });

    await expect(hasToolVersionOnPath('node', '22.4.1')).resolves.toBe(true);
    expect(mockedExec.exec).toHaveBeenCalledWith(
      'node',
      ['--version'],
      expect.objectContaining({ ignoreReturnCode: true, silent: true }),
    );
  });

  it('reads java versions from stderr when probing PATH tools', async () => {
    mockedExec.exec.mockImplementationOnce(async (_command, _args, options) => {
      options?.listeners?.stderr?.(Buffer.from('openjdk version "21.0.7" 2025-04-15\n'));
      return 0;
    });

    await expect(hasToolVersionOnPath('java', '21')).resolves.toBe(true);
  });

  it('detects sccache versions from PATH', async () => {
    mockedExec.exec.mockImplementationOnce(async (_command, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from('sccache 0.13.0\n'));
      return 0;
    });

    await expect(hasToolVersionOnPath('sccache', '0.13.0')).resolves.toBe(true);
  });

  it('refreshes mise shims on demand', async () => {
    await reshimMise();

    expect(mockedCore.info).toHaveBeenCalledWith('Refreshing mise shims...');
    expect(mockedExec.exec).toHaveBeenCalledWith(
      getMiseBinPath(),
      ['reshim', '-f'],
    );
  });

  it('exports mise env vars from json output', async () => {
    mockedExec.exec.mockImplementationOnce(async (_command, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from(JSON.stringify({
        JAVA_HOME: '/tmp/java-21',
        PATH: '/tmp/java-21/bin:/usr/bin',
      })));
      return 0;
    });

    await exportMiseEnv('/tmp/project');

    expect(mockedExec.exec).toHaveBeenCalledWith(
      getMiseBinPath(),
      ['env', '--json'],
      expect.objectContaining({ cwd: '/tmp/project', ignoreReturnCode: true, silent: true }),
    );
    expect(mockedCore.exportVariable).toHaveBeenCalledWith('JAVA_HOME', '/tmp/java-21');
    expect(mockedCore.exportVariable).toHaveBeenCalledWith('PATH', '/tmp/java-21/bin:/usr/bin');
  });

  it('falls back to dotenv when json export is unavailable', async () => {
    mockedExec.exec
      .mockImplementationOnce(async () => 1)
      .mockImplementationOnce(async (_command, _args, options) => {
        options?.listeners?.stdout?.(Buffer.from('JAVA_HOME=/tmp/java-21\nPATH=/tmp/java-21/bin:/usr/bin\n'));
        return 0;
      });

    await exportMiseEnv();

    expect(mockedCore.exportVariable).toHaveBeenCalledWith('JAVA_HOME', '/tmp/java-21');
    expect(mockedCore.exportVariable).toHaveBeenCalledWith('PATH', '/tmp/java-21/bin:/usr/bin');
  });

  it('reads string versions from mise.toml', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
ruby = "3.3.1"
`);

    await expect(readMiseTomlVersion('/tmp/project', 'ruby')).resolves.toBe('3.3.1');
  });

  it('reads all tools from .tool-versions', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`# local tools
ruby 3.3.1
node 22.4.1
pnpm 9.15.1 # inline comment
`);

    await expect(readToolVersions('/tmp/project')).resolves.toEqual([
      { name: 'ruby', version: '3.3.1' },
      { name: 'node', version: '22.4.1' },
      { name: 'pnpm', version: '9.15.1' },
    ]);
    await expect(readToolVersionsValue('/tmp/project', 'node')).resolves.toBe('22.4.1');
  });

  it('reads inline table versions from mise.toml', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
python = { version = "3.12.2", virtualenv = ".venv" }
`);

    await expect(readMiseTomlVersion('/tmp/project', 'python')).resolves.toBe('3.12.2');
  });

  it('reads multiple tools from mise.toml, including multiline tables', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
ruby = "3.3.1"
python = {
  version = "3.12.2",
  virtualenv = ".venv",
}
pnpm = { version = "9.15.1", postinstall = "pnpm --version" }
`);

    await expect(readMiseTomlTools('/tmp/project')).resolves.toEqual([
      { name: 'ruby', version: '3.3.1' },
      { name: 'python', version: '3.12.2' },
      { name: 'pnpm', version: '9.15.1' },
    ]);
  });

  it('returns null when the tool is absent from mise.toml', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
node = "22"
`);

    await expect(readMiseTomlVersion('/tmp/project', 'python')).resolves.toBeNull();
  });

  it('prefers mise.toml over .tool-versions for project tool resolution', async () => {
    mockedFs.promises.readFile.mockImplementation(async (filePath: fs.PathLike | unknown) => {
      const normalizedPath = String(filePath);
      if (normalizedPath.endsWith('.tool-versions')) {
        return `ruby 3.3.1
node 20.11.1
`;
      }

      if (normalizedPath.endsWith('mise.toml')) {
        return `[tools]
node = "22.4.1"
pnpm = "9.15.1"
`;
      }

      throw new Error(`Unexpected path: ${normalizedPath}`);
    });

    await expect(readProjectMiseTools('/tmp/project')).resolves.toEqual([
      { name: 'ruby', version: '3.3.1' },
      { name: 'node', version: '22.4.1' },
      { name: 'pnpm', version: '9.15.1' },
    ]);
  });
});
