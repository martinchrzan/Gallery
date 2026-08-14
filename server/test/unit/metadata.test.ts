import { describe, expect, it } from 'vitest';
import { dateFromFilename } from '../../src/metadata.js';

/** Local time, because that is what the parser builds. */
function local(year: number, month: number, day: number, hour = 12, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

describe('dateFromFilename', () => {
  it('reads the shapes phones and cameras actually produce', () => {
    expect(dateFromFilename('IMG_20190704_132231.jpg')).toBe(local(2019, 7, 4, 13, 22, 31));
    expect(dateFromFilename('VID_20190704_132231.mp4')).toBe(local(2019, 7, 4, 13, 22, 31));
    expect(dateFromFilename('IMG-20190704-WA0001.jpg')).toBe(local(2019, 7, 4));
    expect(dateFromFilename('2019-07-04 13.22.31.png')).toBe(local(2019, 7, 4, 13, 22, 31));
    expect(dateFromFilename('Screenshot_2019.07.04.png')).toBe(local(2019, 7, 4));
  });

  it('defaults a dateless match to midday, not midnight', () => {
    // Midday keeps the photo on the right side of a timezone shift when the
    // filename gives no clock time at all.
    expect(dateFromFilename('20190704.jpg')).toBe(local(2019, 7, 4, 12, 0, 0));
  });

  it('returns null when there is no date in the name', () => {
    expect(dateFromFilename('holiday.jpg')).toBeNull();
    expect(dateFromFilename('DSC_0042.jpg')).toBeNull();
    expect(dateFromFilename('')).toBeNull();
  });

  it('rejects an impossible month, day or clock', () => {
    expect(dateFromFilename('20191304.jpg')).toBeNull();
    expect(dateFromFilename('20190732.jpg')).toBeNull();
    expect(dateFromFilename('20190704_256131.jpg')).toBeNull();
    expect(dateFromFilename('20190704_136031.jpg')).toBeNull();
  });

  it('ignores a run of digits that would land in the future', () => {
    // Guards against reading an unrelated number — a serial, a resolution — as
    // a capture date.
    const nextCentury = new Date().getFullYear() + 10;
    expect(dateFromFilename(`IMG_${nextCentury}0704.jpg`)).toBeNull();
  });

  it('only accepts 19xx and 20xx years', () => {
    expect(dateFromFilename('IMG_18990704.jpg')).toBeNull();
    expect(dateFromFilename('IMG_19990704.jpg')).toBe(local(1999, 7, 4));
  });
});
