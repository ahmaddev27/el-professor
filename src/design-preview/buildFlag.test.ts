import { describe, expect, it } from 'vitest';
import { designPreviewEnabled } from './buildFlag';

describe('designPreviewEnabled', () => {
  it('is on for the dev server unless the environment is production', () => {
    expect(designPreviewEnabled('serve', undefined)).toBe(true);
    expect(designPreviewEnabled('serve', 'staging')).toBe(true);
    expect(designPreviewEnabled('serve', 'production')).toBe(false);
  });

  it('is off for a build without VITE_DEPLOY_ENV, which is how production builds', () => {
    expect(designPreviewEnabled('build', undefined)).toBe(false);
    expect(designPreviewEnabled('build', '')).toBe(false);
    expect(designPreviewEnabled('build', '   ')).toBe(false);
  });

  it('is off for a build that names production, however it is spelled', () => {
    expect(designPreviewEnabled('build', 'production')).toBe(false);
    expect(designPreviewEnabled('build', ' production ')).toBe(false);
    expect(designPreviewEnabled('build', 'Production')).toBe(false);
  });

  it('is on for a staging build', () => {
    expect(designPreviewEnabled('build', 'staging')).toBe(true);
  });
});
