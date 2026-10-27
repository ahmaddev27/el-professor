import { useEffect, useState } from 'react';
import { loadAuthProviderSettings } from '../lib/authProviderSettings';
import { passkeysUsable } from '../lib/passkeyClient';

/**
 * Whether any passkey control may be drawn at all.
 *
 * Two conditions, and both have to hold:
 *
 *  - **GoTrue serves the routes.** `GET /auth/v1/settings` reports
 *    `passkeys_enabled` from v2.188.0 onward. The image this stack pins is
 *    v2.170.0, which does not know the field, so it is absent — and absent reads
 *    as off. That is what keeps this whole slice dark until the GoTrue upgrade
 *    lands, with no flag of our own to get out of step with the server.
 *  - **The browser can run a ceremony.** Without `navigator.credentials` a
 *    passkey control could only fail, and the password form beside it is
 *    already the way in.
 *
 * It starts `false` and turns true only once the server has answered, so a
 * control never flashes into view and then back out: the answer is cached for
 * the page load, so the second and third caller get it without a request.
 *
 * One hook rather than the same six lines in three components, because "may we
 * draw this" is exactly the question that must not come to differ between the
 * sign-in button, the account card and the re-authentication form.
 */
export function usePasskeysEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadAuthProviderSettings().then(settings => {
      if (!cancelled) setEnabled(settings.passkeys && passkeysUsable());
    });
    return () => { cancelled = true; };
  }, []);

  return enabled;
}
