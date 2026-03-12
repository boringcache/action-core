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
  installMise,
  installMiseTool,
  readMiseTomlVersion,
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
    expect(mockedCore.addPath).toHaveBeenCalledWith(path.join(getMiseDataDir(), 'shims'));
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

  it('reads string versions from mise.toml', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
ruby = "3.3.1"
`);

    await expect(readMiseTomlVersion('/tmp/project', 'ruby')).resolves.toBe('3.3.1');
  });

  it('reads inline table versions from mise.toml', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
python = { version = "3.12.2", virtualenv = ".venv" }
`);

    await expect(readMiseTomlVersion('/tmp/project', 'python')).resolves.toBe('3.12.2');
  });

  it('returns null when the tool is absent from mise.toml', async () => {
    mockedFs.promises.readFile.mockResolvedValue(`[tools]
node = "22"
`);

    await expect(readMiseTomlVersion('/tmp/project', 'python')).resolves.toBeNull();
  });
});
