import React, { useState, useEffect } from 'react';
import { X, Save, FileText, Upload, Image as ImageIcon, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

interface DocumentTemplate {
  id: string;
  name: string;
  file_url: string;
  thumbnail_url?: string;
  last_used_at: string;
  usage_count: number;
}

interface CreateDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CreateDocumentModal: React.FC<CreateDocumentModalProps> = ({ isOpen, onClose }) => {
  const { success, error: showError } = useToast();
  const { companyId } = useAuth();

  const [formData, setFormData] = useState({
    title: '', content: '', signaturePart1: '', signaturePart2: '',
  });
  const [templateSource, setTemplateSource] = useState<'upload' | 'recent'>('recent');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [recentTemplates, setRecentTemplates] = useState<DocumentTemplate[]>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  useEffect(() => {
    if (isOpen) loadRecentTemplates();
  }, [isOpen]);

  const loadRecentTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const { data, error } = await supabase
        .from('document_templates')
        .select('*')
        .eq('company_id', companyId)
        .order('last_used_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      setRecentTemplates(data || []);
    } catch (err: any) {
      console.error('Error loading templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { showError('Nur PDF-Dateien sind erlaubt'); return; }
    if (file.size > 10 * 1024 * 1024) { showError('Datei ist zu groß (max. 10MB)'); return; }
    setUploadFile(file);
    setUploadPreview(file.name);
  };

  const uploadTemplate = async (): Promise<DocumentTemplate | null> => {
    if (!uploadFile) return null;
    try {
      const fileName = `${Date.now()}-${uploadFile.name}`;
      const { error: uploadError } = await supabase.storage
        .from('document-templates').upload(fileName, uploadFile, { cacheControl: '3600', upsert: false });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from('document-templates').getPublicUrl(fileName);
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not authenticated');

      const { data: template, error: dbError } = await supabase
        .from('document_templates')
        .insert({ name: uploadFile.name.replace('.pdf', ''), file_path: fileName, file_url: urlData.publicUrl, created_by: user.user.id, company_id: companyId })
        .select().single();
      if (dbError) throw dbError;
      return template;
    } catch (err: any) {
      showError('Fehler beim Hochladen', err.message);
      return null;
    }
  };

  const updateTemplateUsage = async (templateId: string) => {
    try {
      await supabase.from('document_templates')
        .update({ last_used_at: new Date().toISOString(), usage_count: supabase.raw('usage_count + 1') })
        .eq('id', templateId);
    } catch (err) { console.error('Error updating template usage:', err); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) { showError('Bitte geben Sie einen Titel ein'); return; }
    if (templateSource === 'recent' && !selectedTemplateId) { showError('Bitte wählen Sie eine Vorlage aus'); return; }
    if (templateSource === 'upload' && !uploadFile) { showError('Bitte laden Sie eine PDF-Vorlage hoch'); return; }

    setLoading(true);
    try {
      let templateToUse: DocumentTemplate | null = null;
      if (templateSource === 'upload') {
        templateToUse = await uploadTemplate();
        if (!templateToUse) { setLoading(false); return; }
      } else {
        const template = recentTemplates.find(t => t.id === selectedTemplateId);
        if (template) { templateToUse = template; await updateTemplateUsage(template.id); }
      }
      if (!templateToUse) { showError('Vorlage konnte nicht geladen werden'); setLoading(false); return; }

      console.log('Document data to save:', {
        title: formData.title.trim(),
        content: formData.content.trim(),
        signature_part_1: formData.signaturePart1.trim() || null,
        signature_part_2: formData.signaturePart2.trim() || null,
        template_id: templateToUse.id,
        template_url: templateToUse.file_url,
      });

      success('Dokument erfolgreich erstellt');
      setFormData({ title: '', content: '', signaturePart1: '', signaturePart2: '' });
      setUploadFile(null); setUploadPreview(''); setSelectedTemplateId('');
      onClose();
    } catch (err: any) {
      showError('Fehler beim Erstellen', err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const labelStyle: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 500 };
  const sectionHeadStyle: React.CSSProperties = { color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 600 };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div
        className="rounded-xl shadow-2xl w-full max-w-3xl my-8"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* Header */}
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: 'var(--accent-subtle)' }}>
              <FileText className="w-5 h-5" style={{ color: 'var(--accent-text)' }} />
            </div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Neues Dokument erstellen
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Template section */}
          <div className="space-y-4">
            <h3 style={sectionHeadStyle}>PDF-Vorlage wählen</h3>

            {/* Source toggle */}
            <div className="flex gap-3">
              {(['recent', 'upload'] as const).map(src => {
                const isActive = templateSource === src;
                return (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setTemplateSource(src)}
                    className="flex-1 py-3 px-4 rounded-xl transition-colors text-center"
                    style={{
                      border: `2px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                      background: isActive ? 'var(--accent-subtle)' : 'var(--bg-subtle)',
                      color: isActive ? 'var(--accent-text)' : 'var(--text-secondary)',
                    }}
                  >
                    {src === 'recent'
                      ? <Clock className="mx-auto mb-1.5 w-5 h-5" />
                      : <Upload className="mx-auto mb-1.5 w-5 h-5" />
                    }
                    <span className="text-sm font-medium">
                      {src === 'recent' ? 'Letzte Vorlagen' : 'Neue Vorlage hochladen'}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Recent templates list */}
            {templateSource === 'recent' && (
              <div className="space-y-2">
                {loadingTemplates ? (
                  <div className="text-center py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Lade Vorlagen...
                  </div>
                ) : recentTemplates.length === 0 ? (
                  <div className="text-center py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Keine Vorlagen vorhanden. Laden Sie eine neue Vorlage hoch.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto">
                    {recentTemplates.map(template => {
                      const isSelected = selectedTemplateId === template.id;
                      return (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => setSelectedTemplateId(template.id)}
                          className="p-4 rounded-xl text-left transition-colors"
                          style={{
                            border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                            background: isSelected ? 'var(--accent-subtle)' : 'var(--bg-subtle)',
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <ImageIcon className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                {template.name}
                              </p>
                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                Verwendet: {template.usage_count}x
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Upload zone */}
            {templateSource === 'upload' && (
              <label className="block cursor-pointer">
                <div
                  className="border-2 border-dashed rounded-xl p-6 text-center transition-colors"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--bg-subtle)',
                  }}
                  onMouseEnter={e => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)')}
                  onMouseLeave={e => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--border)')}
                >
                  <Upload className="mx-auto mb-2 w-8 h-8" style={{ color: 'var(--text-tertiary)' }} />
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    PDF-Vorlage hochladen
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    Klicken oder Datei hierher ziehen
                  </p>
                  {uploadPreview && (
                    <p className="text-sm mt-2 font-medium" style={{ color: 'var(--accent-text)' }}>
                      {uploadPreview}
                    </p>
                  )}
                </div>
                <input type="file" accept=".pdf" onChange={handleFileChange} className="hidden" disabled={loading} />
              </label>
            )}
          </div>

          {/* Document content section */}
          <div className="space-y-4 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
            <h3 className="pt-2" style={sectionHeadStyle}>Dokumentinhalt</h3>

            <div>
              <label className="block mb-1.5" style={labelStyle}>Titel *</label>
              <input
                type="text"
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
                className="input-base"
                placeholder="z.B. Fahrervertrag, Gehaltsabrechnung"
                required
                disabled={loading}
              />
            </div>

            <div>
              <label className="block mb-1.5" style={labelStyle}>Inhalt *</label>
              <textarea
                value={formData.content}
                onChange={e => setFormData({ ...formData, content: e.target.value })}
                className="input-base"
                placeholder="Hauptinhalt des Dokuments"
                rows={6}
                required
                disabled={loading}
                style={{ resize: 'vertical' }}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block mb-1.5" style={labelStyle}>Unterschrift Teil 1</label>
                <input
                  type="text"
                  value={formData.signaturePart1}
                  onChange={e => setFormData({ ...formData, signaturePart1: e.target.value })}
                  className="input-base"
                  placeholder="z.B. Ort, Datum"
                  disabled={loading}
                />
              </div>
              <div>
                <label className="block mb-1.5" style={labelStyle}>Unterschrift Teil 2</label>
                <input
                  type="text"
                  value={formData.signaturePart2}
                  onChange={e => setFormData({ ...formData, signaturePart2: e.target.value })}
                  className="input-base"
                  placeholder="z.B. Name, Funktion"
                  disabled={loading}
                />
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Lassen Sie beide Felder leer, wenn keine Unterschrift benötigt wird
            </p>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
            >
              <Save className="w-4 h-4" />
              {loading ? 'Erstellen...' : 'Dokument erstellen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateDocumentModal;
