import React, { useState, useRef } from 'react';
import { X, Upload, FileText } from 'lucide-react';
import { useDocuments } from '../hooks/useDocuments';
import { useToast } from '../contexts/ToastContext';
import type { DocumentCategory } from '../types/document';

interface UploadDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: DocumentCategory[];
}

const UploadDocumentModal: React.FC<UploadDocumentModalProps> = ({ isOpen, onClose, categories }) => {
  const { createDocument, uploadFile } = useDocuments();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState({ title: '', description: '', category: 'Allgemein' });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);

  const acceptedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'image/png', 'image/jpeg', 'image/jpg',
  ];

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) handleFileSelection(e.dataTransfer.files[0]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) handleFileSelection(e.target.files[0]);
  };

  const handleFileSelection = (file: File) => {
    if (!acceptedTypes.includes(file.type)) {
      showToast('error', 'Dateityp nicht unterstützt. Bitte laden Sie PDF, DOCX oder Bild hoch.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast('error', 'Datei zu groß. Maximale Dateigröße: 10MB');
      return;
    }
    setSelectedFile(file);
    if (!formData.title) setFormData({ ...formData, title: file.name.replace(/\.[^/.]+$/, '') });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) { showToast('error', 'Bitte wählen Sie eine Datei aus'); return; }
    if (!formData.title.trim()) { showToast('error', 'Bitte geben Sie einen Titel ein'); return; }

    setLoading(true);
    try {
      const fileUrl = await uploadFile(selectedFile);
      await createDocument({
        title: formData.title.trim(),
        description: formData.description.trim() || undefined,
        category: formData.category,
        source_type: 'uploaded',
        status: 'active',
        file_url: fileUrl,
        file_type: selectedFile.type,
        file_size: selectedFile.size,
      });
      showToast('success', 'Datei erfolgreich hochgeladen');
      onClose();
      setFormData({ title: '', description: '', category: 'Allgemein' });
      setSelectedFile(null);
    } catch (error: any) {
      showToast('error', error.message || 'Fehler beim Hochladen');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const labelStyle: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 500 };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div
        className="rounded-xl shadow-2xl w-full max-w-md"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* Header */}
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: 'var(--accent-subtle)' }}>
              <Upload className="w-5 h-5" style={{ color: 'var(--accent-text)' }} />
            </div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Datei hochladen
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

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Drop zone */}
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className="border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer"
            style={{
              borderColor: dragActive ? 'var(--accent)' : 'var(--border)',
              background: dragActive ? 'var(--accent-subtle)' : 'var(--bg-subtle)',
            }}
            onClick={() => !selectedFile && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileChange}
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
              className="hidden"
            />
            {selectedFile ? (
              <div className="space-y-2">
                <FileText className="w-12 h-12 mx-auto" style={{ color: 'var(--success)' }} />
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {selectedFile.name}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setSelectedFile(null); }}
                  className="text-sm font-medium transition-opacity hover:opacity-70"
                  style={{ color: 'var(--accent-text)' }}
                >
                  Andere Datei wählen
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="w-12 h-12 mx-auto" style={{ color: 'var(--text-tertiary)' }} />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Datei hierher ziehen oder{' '}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="font-medium transition-opacity hover:opacity-70"
                    style={{ color: 'var(--accent-text)' }}
                  >
                    durchsuchen
                  </button>
                </p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  PDF, DOCX oder Bilder (max. 10MB)
                </p>
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="block mb-1.5" style={labelStyle}>Titel *</label>
            <input
              type="text"
              value={formData.title}
              onChange={e => setFormData({ ...formData, title: e.target.value })}
              className="input-base"
              placeholder="Dokumenttitel"
              required
              disabled={loading}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block mb-1.5" style={labelStyle}>Beschreibung</label>
            <textarea
              value={formData.description}
              onChange={e => setFormData({ ...formData, description: e.target.value })}
              className="input-base"
              placeholder="Kurze Beschreibung"
              rows={2}
              disabled={loading}
              style={{ resize: 'vertical' }}
            />
          </div>

          {/* Category */}
          <div>
            <label className="block mb-1.5" style={labelStyle}>Kategorie</label>
            <select
              value={formData.category}
              onChange={e => setFormData({ ...formData, category: e.target.value })}
              className="input-base"
              disabled={loading}
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
            >
              {categories.map(cat => (
                <option key={cat.id} value={cat.name}
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                >
                  {cat.name}
                </option>
              ))}
            </select>
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
              disabled={loading || !selectedFile}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'white' }}
              onMouseEnter={e => { if (!loading && selectedFile) e.currentTarget.style.background = 'var(--accent-hover)'; }}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
            >
              <Upload className="w-4 h-4" />
              {loading ? 'Hochladen...' : 'Hochladen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default UploadDocumentModal;
