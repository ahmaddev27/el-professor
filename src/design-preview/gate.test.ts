import { describe, expect, it } from 'vitest';
import { DESIGN_PREVIEW_PATH, isDesignPreviewPath } from './gate';

describe('isDesignPreviewPath', () => {
  it('matches the preview and its pages', () => {
    expect(isDesignPreviewPath(DESIGN_PREVIEW_PATH)).toBe(true);
    expect(isDesignPreviewPath(`${DESIGN_PREVIEW_PATH}/`)).toBe(true);
    expect(isDesignPreviewPath(`${DESIGN_PREVIEW_PATH}/fahrzeuge`)).toBe(true);
  });

  it('leaves every other path to the app', () => {
    expect(isDesignPreviewPath('/')).toBe(false);
    expect(isDesignPreviewPath('/cars')).toBe(false);
    expect(isDesignPreviewPath('/design')).toBe(false);
    expect(isDesignPreviewPath(`${DESIGN_PREVIEW_PATH}er`)).toBe(false);
    expect(isDesignPreviewPath(`/overview${DESIGN_PREVIEW_PATH}`)).toBe(false);
  });
});
