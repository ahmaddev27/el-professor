/**
 * Stands in for useOtpSessionHandoff in the batch-4 harness.
 *
 * The real hook installs the session and lets App swap its router; the harness
 * has one in-memory router and no App, so this records the hand-off and moves
 * that router to the destination, which is what the person sees next.
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OtpSession } from '../../../src/lib/otpClient';
import { recordWrite } from './supabase';

export function useOtpSessionHandoff() {
  const navigate = useNavigate();
  return useCallback(
    async (_session: OtpSession, destination: string): Promise<boolean> => {
      recordWrite('handoff', 'setSession', { destination });
      navigate(destination, { replace: true });
      return true;
    },
    [navigate],
  );
}
