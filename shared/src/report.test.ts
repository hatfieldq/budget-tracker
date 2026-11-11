import { describe, expect, it } from 'vitest';
import { dayBefore, presetRange } from './report';

describe('period presets', () => {
  it('this/last month, YTD, last year, including January and leap years', () => {
    expect(presetRange('this-month', '2026-11-10')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(presetRange('last-month', '2026-11-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('last-month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('last-month', '2028-03-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(presetRange('ytd', '2026-11-10')).toEqual({ from: '2026-01-01', to: '2026-11-10' });
    expect(presetRange('last-year', '2026-11-10')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('dayBefore crosses month and year ends', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
  });
});
