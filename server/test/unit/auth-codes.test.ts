import { describe, expect, it } from 'vitest';
import { generateCode, normalizeCode, normalizeFolders } from '../../src/auth.js';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('generateCode', () => {
  it('is dash-grouped in fours, for reading aloud', () => {
    expect(generateCode()).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  });

  it('draws only from the unambiguous alphabet', () => {
    // No 0/O, 1/I/L or U — the pairs a person mistypes when copying a code off
    // a screen or hearing it over the phone.
    for (let i = 0; i < 200; i++) {
      for (const ch of generateCode().replace(/-/g, '')) {
        expect(ALPHABET, `unexpected character ${ch}`).toContain(ch);
      }
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateCode());
    expect(seen.size).toBe(500);
  });

  it('carries the ~78 bits the README claims', () => {
    const bits = 16 * Math.log2(ALPHABET.length);
    expect(bits).toBeGreaterThan(78);
  });
});

describe('normalizeCode', () => {
  it('treats case and dashes as cosmetic', () => {
    expect(normalizeCode('a7k2-9f3m-qx4t-vb7n')).toBe('A7K29F3MQX4TVB7N');
    expect(normalizeCode('A7K29F3MQX4TVB7N')).toBe('A7K29F3MQX4TVB7N');
    expect(normalizeCode(' A7K2 9F3M ')).toBe('A7K29F3M');
  });

  it('strips anything a paste might drag in', () => {
    expect(normalizeCode('A7K2—9F3M\n')).toBe('A7K29F3M');
  });

  it('is idempotent, so hashing and verifying cannot drift', () => {
    const once = normalizeCode('a7k2-9f3m');
    expect(normalizeCode(once)).toBe(once);
  });

  it('reduces an all-punctuation input to nothing', () => {
    expect(normalizeCode('----')).toBe('');
  });
});

describe('normalizeFolders', () => {
  it('normalises separators and de-duplicates', () => {
    expect(normalizeFolders(['Travel', 'Travel\\', '/Travel/'])).toEqual(['Travel']);
    expect(normalizeFolders(['A/B', 'C'])).toEqual(['A/B', 'C']);
  });

  it('keeps the root entry, which means the whole library', () => {
    expect(normalizeFolders([''])).toEqual(['']);
  });
});
