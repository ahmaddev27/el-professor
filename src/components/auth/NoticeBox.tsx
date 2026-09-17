import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { AuthSurface } from './authStyles';

interface NoticeBoxProps {
  tone: 'success' | 'error';
  surface?: AuthSurface;
  /**
   * Give the box its own live-region role. Leave it off inside a container that
   * is already a live region, or screen readers announce the message twice.
   */
  announce?: boolean;
  children: React.ReactNode;
}

const NoticeBox: React.FC<NoticeBoxProps> = ({ tone, surface = 'dark', announce = false, children }) => {
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  const role = announce ? (tone === 'error' ? 'alert' : 'status') : undefined;

  if (surface === 'app') {
    return (
      <div
        role={role}
        className="flex items-start gap-2 rounded-lg p-3 text-sm"
        style={{
          background: tone === 'error' ? 'var(--danger-subtle)' : 'var(--success-subtle)',
          color: tone === 'error' ? 'var(--danger)' : 'var(--success)',
        }}
      >
        <Icon size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0">{children}</div>
      </div>
    );
  }

  const palette = tone === 'error'
    ? 'bg-red-500/10 border-red-500/20 text-red-300'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300';
  return (
    <div role={role} className={`p-3.5 border rounded-xl flex items-start gap-2.5 text-sm leading-relaxed ${palette}`}>
      <Icon
        size={16}
        className={`flex-shrink-0 mt-0.5 ${tone === 'error' ? 'text-red-400' : 'text-emerald-400'}`}
        aria-hidden="true"
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
};

export default NoticeBox;
