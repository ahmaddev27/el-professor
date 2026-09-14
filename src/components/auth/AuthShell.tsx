import React from 'react';
import LanguageSwitcher from '../LanguageSwitcher';

interface AuthShellProps {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** The frame of the signed-out screens: dark grid backdrop, logo, heading, one card. */
const AuthShell: React.FC<AuthShellProps> = ({ title, subtitle, children, footer }) => (
  <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4 relative overflow-hidden">
    <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
    <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-600/5 rounded-full blur-[120px] pointer-events-none" />

    <div className="absolute top-4 right-4 z-10">
      <LanguageSwitcher variant="dark" />
    </div>

    <div className="relative w-full max-w-sm">
      <div className="text-center mb-8">
        <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center">
          <img
            src="/professor_logo_white.svg"
            alt="El-Professor"
            className="w-16 h-16 object-contain drop-shadow-[0_0_16px_rgba(6,182,212,0.5)]"
          />
        </div>
        <h1 className="text-2xl font-bold text-white mb-1">{title}</h1>
        {subtitle && <p className="text-white/40 text-sm break-words">{subtitle}</p>}
      </div>

      <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
        {children}
      </div>

      {footer && <div className="mt-6 text-center">{footer}</div>}
    </div>
  </div>
);

export default AuthShell;
