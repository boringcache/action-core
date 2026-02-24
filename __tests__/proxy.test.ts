import { normalizeProxyTags } from '../lib/proxy';

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
