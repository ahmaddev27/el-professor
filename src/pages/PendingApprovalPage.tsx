import React from 'react';
import { Clock, LogOut, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const PendingApprovalPage: React.FC = () => {
  const { signOut, profile } = useAuth();

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-amber-500/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative w-full max-w-md text-center">
        <div className="mb-8">
          <img src="/professor_logo_white.svg" alt="El-Professor" className="w-12 h-12 object-contain mx-auto drop-shadow-[0_0_12px_rgba(6,182,212,0.4)]" />
        </div>

        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
          <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/25 flex items-center justify-center mx-auto mb-6">
            <Clock className="text-amber-400" size={28} />
          </div>

          <h1 className="text-xl font-bold text-white mb-3">Registrierung eingegangen</h1>

          <p className="text-white/55 text-sm leading-relaxed mb-2">
            Vielen Dank für Ihre Anmeldung{profile?.full_name ? `, ${profile.full_name}` : ''}.
          </p>
          <p className="text-white/55 text-sm leading-relaxed mb-6">
            Ihr Unternehmenskonto wird derzeit von unserem Team geprüft. Sie erhalten eine E-Mail, sobald Ihr Zugang freigeschaltet wurde.
          </p>

          <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 mb-6">
            <div className="flex items-start gap-3">
              <Mail size={15} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-white/50 text-left leading-relaxed">
                Bei Fragen wenden Sie sich bitte an{' '}
                <a
                  href="mailto:support@el-professor.de"
                  className="text-amber-400 hover:text-amber-300 transition-colors"
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

export default PendingApprovalPage;
