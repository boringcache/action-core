import * as os from 'os';
import * as path from 'path';
import { convertCacheFormatToEntries, parseEntries } from '../lib/inputs';

describe('parseEntries', () => {
  it('accepts comma-separated entries', () => {
    expect(parseEntries('deps:node_modules,build:dist', 'restore', { resolvePaths: false })).toEqual([
      { tag: 'deps', restorePath: 'node_modules', savePath: 'node_modules' },
      { tag: 'build', restorePath: 'dist', savePath: 'dist' },
    ]);
  });

  it('accepts newline-separated entries', () => {
    expect(parseEntries('deps:node_modules\nbuild:dist', 'restore', { resolvePaths: false })).toEqual([
      { tag: 'deps', restorePath: 'node_modules', savePath: 'node_modules' },
      { tag: 'build', restorePath: 'dist', savePath: 'dist' },
    ]);
  });

  it('resolves relative entries against the provided base directory', () => {
    const baseDir = path.join(os.tmpdir(), 'boringcache-base');

    expect(parseEntries('deps:node_modules', 'restore', { baseDir })).toEqual([
      {
        tag: 'deps',
        restorePath: path.join(baseDir, 'node_modules'),
        savePath: path.join(baseDir, 'node_modules'),
      },
    ]);
  });
});

describe('convertCacheFormatToEntries', () => {
  it('resolves actions/cache paths against workingDirectory when provided', () => {
    const workingDirectory = path.join(os.tmpdir(), 'boringcache-workdir');

    expect(convertCacheFormatToEntries({
      path: 'node_modules\n.npm-cache',
      key: 'deps',
      noPlatform: true,
      workingDirectory,
    }, 'restore')).toBe(
      `deps:${path.join(workingDirectory, 'node_modules')},deps:${path.join(workingDirectory, '.npm-cache')}`,
    );
  });
});
