import React from 'react';
import { XCircle, LogOut, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const RejectedPage: React.FC = () => {
  const { signOut, rejectionReason } = useAuth();

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-red-500/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative w-full max-w-md text-center">
        <div className="mb-8">
          <img src="/professor_logo_white.svg" alt="El-Professor" className="w-12 h-12 object-contain mx-auto drop-shadow-[0_0_12px_rgba(6,182,212,0.4)]" />
        </div>

        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
          <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center mx-auto mb-6">
            <XCircle className="text-red-400" size={28} />
          </div>

          <h1 className="text-xl font-bold text-white mb-3">Registrierung abgelehnt</h1>

          <p className="text-white/55 text-sm leading-relaxed mb-4">
            Leider konnte Ihre Registrierungsanfrage nicht genehmigt werden.
          </p>

          {rejectionReason && (
            <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 mb-4 text-left">
              <p className="text-xs font-semibold text-red-400/80 uppercase tracking-wider mb-1.5">Grund</p>
              <p className="text-sm text-white/60 leading-relaxed">{rejectionReason}</p>
            </div>
          )}

          <div className="p-4 rounded-xl border border-white/10 bg-white/3 mb-6">
            <div className="flex items-start gap-3">
              <Mail size={15} className="text-white/40 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-white/50 text-left leading-relaxed">
                Für weitere Informationen oder Rückfragen wenden Sie sich bitte an{' '}
                <a
                  href="mailto:support@el-professor.de"
                  className="text-cyan-400 hover:text-cyan-300 transition-colors"
                >
                  support@el-professor.de
                </a>
              </p>
            </div>
          </div>

          <button
            onClick={signOut}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-white/10 text-white/50 hover:text-white/80 hover:border-white/20 transition-all text-sm"
          >
            <LogOut size={14} />
            Abmelden
          </button>
        </div>
      </div>
    </div>
  );
};

export default RejectedPage;
