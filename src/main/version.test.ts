import { describe, expect, it } from 'vitest';
import { compareVersions } from './version';

describe('compareVersions', () => {
  it('orders versions numerically', () => {
    expect(compareVersions('v1.2.0', '1.1.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0);
    expect(compareVersions('1.1.9', 'v1.2.0')).toBeLessThan(0);
  });
});
