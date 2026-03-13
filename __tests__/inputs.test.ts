import { parseEntries } from '../lib/inputs';

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
});
