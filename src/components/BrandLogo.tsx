import React from 'react';

/**
 * The El-Professor mark, in the variant for the theme on screen.
 *
 * One component rather than the same pair of `<img>` tags in three places. The
 * assets are the ones already cut from the owner's brand board and living in
 * `public/brand/` — `mark-on-light.png` and `mark-on-dark.png`, both transparent
 * PNGs — so nothing new is added to the repository and the sidebar cannot drift
 * from the signed-out screens, which render the same two files through
 * `components/auth/BrandMark`.
 *
 * `ThemeProvider` puts `.dark` on the document root, so the Tailwind `dark:`
 * variants below work in the legacy shell as well as in the design-system one.
 *
 * The mark is decorative wherever a name sits beside it, which is every current
 * caller: the company sidebar prints the company's name and the platform sidebar
 * prints the panel's title. So `alt` is empty by default, and a caller that shows
 * the mark alone passes one.
 */
const BrandLogo: React.FC<{ className?: string; alt?: string }> = ({
  className = 'w-8 h-8 object-contain',
  alt = '',
}) => (
  <>
    <img src="/brand/mark-on-light.png" alt={alt} className={`${className} dark:hidden`} />
    <img src="/brand/mark-on-dark.png" alt={alt} className={`${className} hidden dark:block`} />
  </>
);

export default BrandLogo;
