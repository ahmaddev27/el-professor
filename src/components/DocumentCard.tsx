import React, { useState } from 'react';
import { FileText, MoreVertical, Eye, CreditCard as Edit, Copy, Download, Archive, Trash2, FileUp, LayoutTemplate, FileCheck, Calendar, Pin } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Document } from '../types/document';
import ConfirmationModal from './ConfirmationModal';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

interface DocumentCardProps {
  document: Document;
  viewMode: 'grid' | 'list';
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}

const DocumentCard: React.FC<DocumentCardProps> = ({
  document,
  viewMode,
  onDelete,
  onDuplicate,
}) => {
  const navigate = useNavigate();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const getSourceIcon = () => {
    switch (document.source_type) {
      case 'uploaded':
        return <FileUp size={16} className="text-green-600" />;
      case 'template':
        return <LayoutTemplate size={16} className="text-blue-600" />;
      case 'generated':
        return <FileCheck size={16} className="text-purple-600" />;
      default:
        return <FileText size={16} className="text-gray-600" />;
    }
  };

  const getSourceLabel = () => {
    switch (document.source_type) {
      case 'uploaded':
        return 'Hochgeladen';
      case 'template':
        return 'Vorlage';
      case 'generated':
        return 'Generiert';
      default:
        return 'Dokument';
    }
  };

  const getStatusBadge = () => {
    const badges = {
      draft: { label: 'Entwurf', className: 'bg-yellow-100 text-yellow-800' },
      active: { label: 'Aktiv', className: 'bg-green-100 text-green-800' },
      archived: { label: 'Archiviert', className: 'bg-gray-100 text-gray-800' },
    };

    const badge = badges[document.status];
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${badge.className}`}>
        {badge.label}
      </span>
    );
  };

  const handleView = () => {
    if (document.source_type === 'uploaded' && document.file_url) {
      window.open(document.file_url, '_blank');
    } else {
      navigate(`/dokumente/${document.id}`);
    }
  };

  const handleEdit = () => {
    navigate(`/dokumente/${document.id}/bearbeiten`);
  };

  const handleDownload = () => {
    if (document.file_url) {
      window.open(document.file_url, '_blank');
    }
  };

  const handleDeleteClick = () => {
    setShowMenu(false);
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = () => {
    onDelete(document.id);
    setShowDeleteModal(false);
  };

  const handleDuplicate = () => {
    setShowMenu(false);
    onDuplicate(document.id);
  };

  if (viewMode === 'list') {
    return (
      <>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4 flex-1 min-w-0">
              <div className="flex-shrink-0">
                <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center">
                  <FileText size={24} className="text-gray-600" />
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <h3 className="text-lg font-semibold text-gray-900 truncate">
                    {document.title}
                  </h3>
                  {document.is_pinned && <Pin size={14} className="text-yellow-500 fill-current" />}
                </div>

                {document.description && (
                  <p className="text-sm text-gray-600 truncate mb-2">{document.description}</p>
                )}

                <div className="flex items-center space-x-3 text-xs text-gray-500">
                  <div className="flex items-center space-x-1">
                    {getSourceIcon()}
                    <span>{getSourceLabel()}</span>
                  </div>
                  <span>•</span>
                  <span className="px-2 py-0.5 bg-gray-100 rounded">{document.category}</span>
                  <span>•</span>
                  <div className="flex items-center space-x-1">
                    <Calendar size={12} />
                    <span>
                      {format(new Date(document.updated_at), 'dd.MM.yyyy', { locale: de })}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                {getStatusBadge()}
              </div>
            </div>

            <div className="flex items-center space-x-2 ml-4">
              <button
                onClick={handleView}
                className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                title="Öffnen"
              >
                <Eye size={18} />
              </button>

              <button
                onClick={handleEdit}
                className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title="Bearbeiten"
              >
                <Edit size={18} />
              </button>

              <div className="relative">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <MoreVertical size={18} />
                </button>

                {showMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowMenu(false)}
                    />
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
                      <button
                        onClick={handleDuplicate}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                      >
                        <Copy size={16} />
                        <span>Duplizieren</span>
                      </button>

                      {document.file_url && (
                        <button
                          onClick={handleDownload}
                          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                        >
                          <Download size={16} />
                          <span>Herunterladen</span>
                        </button>
                      )}

                      <button
                        onClick={handleDeleteClick}
                        className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center space-x-2"
                      >
                        <Trash2 size={16} />
                        <span>Löschen</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <ConfirmationModal
          isOpen={showDeleteModal}
          onClose={() => setShowDeleteModal(false)}
          onConfirm={handleDeleteConfirm}
          title="Dokument löschen"
          message={`Möchten Sie das Dokument "${document.title}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`}
          confirmText="Löschen"
          confirmButtonClass="bg-red-600 hover:bg-red-700"
        />
      </>
    );
  }

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-lg transition-all group">
        <div
          className="aspect-[4/3] bg-gray-100 rounded-t-lg flex items-center justify-center cursor-pointer overflow-hidden"
          onClick={handleView}
        >
          {document.preview_image_url ? (
            <img
              src={document.preview_image_url}
              alt={document.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <FileText size={48} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
          )}
        </div>

        <div className="p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-2 mb-1">
                <h3
                  className="text-lg font-semibold text-gray-900 truncate cursor-pointer hover:text-blue-600 transition-colors"
                  onClick={handleView}
                >
                  {document.title}
                </h3>
                {document.is_pinned && <Pin size={14} className="text-yellow-500 fill-current" />}
              </div>

              {document.description && (
                <p className="text-sm text-gray-600 line-clamp-2 mb-3">
                  {document.description}
                </p>
              )}
            </div>

            <div className="relative ml-2">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors"
              >
                <MoreVertical size={18} />
              </button>

              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowMenu(false)}
                  />
                  <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
                    <button
                      onClick={handleView}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                    >
                      <Eye size={16} />
                      <span>Öffnen</span>
                    </button>

                    <button
                      onClick={handleEdit}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                    >
                      <Edit size={16} />
                      <span>Bearbeiten</span>
                    </button>

                    <button
                      onClick={handleDuplicate}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                    >
                      <Copy size={16} />
                      <span>Duplizieren</span>
                    </button>

                    {document.file_url && (
                      <button
                        onClick={handleDownload}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                      >
                        <Download size={16} />
                        <span>Herunterladen</span>
                      </button>
                    )}

                    <div className="border-t border-gray-200 my-1" />

                    <button
                      onClick={handleDeleteClick}
                      className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center space-x-2"
                    >
                      <Trash2 size={16} />
                      <span>Löschen</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs text-gray-500">
              {getSourceIcon()}
              <span>{getSourceLabel()}</span>
              <span>•</span>
              <span>{document.category}</span>
            </div>

            {getStatusBadge()}
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <div className="flex items-center space-x-1">
              <Calendar size={12} />
              <span>
                {format(new Date(document.updated_at), 'dd.MM.yyyy', { locale: de })}
              </span>
            </div>
          </div>
        </div>
      </div>

      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDeleteConfirm}
        title="Dokument löschen"
        message={`Möchten Sie das Dokument "${document.title}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`}
        confirmText="Löschen"
        confirmButtonClass="bg-red-600 hover:bg-red-700"
      />
    </>
  );
};

export default DocumentCard;
