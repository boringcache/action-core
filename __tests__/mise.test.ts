import * as os from 'os';
import * as path from 'path';

jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    ...jest.requireActual('fs').promises,
    readFile: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    mkdtemp: jest.fn().mockResolvedValue('/tmp/mise-123'),
    copyFile: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
  },
}));

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import {
  activateMiseTool,
  getMiseBinPath,
  getMiseDataDir,
  getMiseInstallsDir,
  getMiseShimsDir,
  installMise,
  installMiseTool,
  readMiseTomlTools,
  readMiseTomlVersion,
  readProjectMiseTools,
  readToolVersions,
  readToolVersionsValue,
  reshimMise,
} from '../lib/mise';

const mockedCore = jest.mocked(core);
const mockedExec = jest.mocked(exec);
const mockedFs = jest.mocked(fs);

describe('mise helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('installs mise and adds the bin and shims directories to PATH', async () => {
    await installMise();

    if (process.platform === 'win32') {
      expect(mockedExec.exec).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining(['-fsSL']),
      );
    } else {
      expect(mockedExec.exec).toHaveBeenCalledWith('sh', ['-c', 'curl https://mise.run | sh']);
    }

    expect(mockedCore.addPath).toHaveBeenCalledWith(path.dirname(getMiseBinPath()));
    expect(mockedCore.addPath).toHaveBeenCalledWith(getMiseShimsDir());
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

  it('refreshes mise shims on demand', async () => {
    await reshimMise();

    expect(mockedCore.info).toHaveBeenCalledWith('Refreshing mise shims...');
    expect(mockedExec.exec).toHaveBeenCalledWith(
      getMiseBinPath(),
      ['reshim', '-f'],
    );
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
