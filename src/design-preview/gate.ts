/** Where the design preview lives. Nothing in the app links here. */
export const DESIGN_PREVIEW_PATH = '/design-preview';

export function isDesignPreviewPath(pathname: string): boolean {
  return pathname === DESIGN_PREVIEW_PATH || pathname.startsWith(`${DESIGN_PREVIEW_PATH}/`);
}
