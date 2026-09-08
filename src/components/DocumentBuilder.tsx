import React, { useState } from 'react';
import { Plus, Trash2, GripVertical, Type, AlignLeft, Image as ImageIcon, Table as TableIcon, Minus, Calendar, Ligature as FileSignature } from 'lucide-react';
import type { DocumentBlock, BlockType, BlockContent } from '../types/document';
import { BLOCK_TYPE_LABELS } from '../types/document';

interface DocumentBuilderProps {
  blocks: DocumentBlock[];
  onBlocksChange: (blocks: DocumentBlock[]) => void;
  variables: string[];
}

const DocumentBuilder: React.FC<DocumentBuilderProps> = ({
  blocks,
  onBlocksChange,
  variables,
}) => {
  const [showBlockMenu, setShowBlockMenu] = useState(false);

  const blockTypes: { type: BlockType; icon: any; label: string }[] = [
    { type: 'title', icon: Type, label: 'Titel' },
    { type: 'subtitle', icon: Type, label: 'Untertitel' },
    { type: 'paragraph', icon: AlignLeft, label: 'Absatz' },
    { type: 'spacer', icon: Minus, label: 'Abstand' },
    { type: 'date_place', icon: Calendar, label: 'Ort und Datum' },
    { type: 'signature', icon: FileSignature, label: 'Unterschrift' },
  ];

  const addBlock = (type: BlockType) => {
    const newBlock: DocumentBlock = {
      id: `temp-${Date.now()}`,
      document_id: '',
      block_type: type,
      content: getDefaultContent(type),
      order: blocks.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    onBlocksChange([...blocks, newBlock]);
    setShowBlockMenu(false);
  };

  const getDefaultContent = (type: BlockType): BlockContent => {
    switch (type) {
      case 'title':
        return { text: 'Titel', fontSize: '24px', fontWeight: 'bold', alignment: 'center' };
      case 'subtitle':
        return { text: 'Untertitel', fontSize: '18px', fontWeight: 'bold', alignment: 'left' };
      case 'paragraph':
        return { text: 'Text hier eingeben...', alignment: 'left' };
      case 'spacer':
        return { height: '20px' };
      case 'date_place':
        return { city: '', date: new Date().toISOString().split('T')[0] };
      case 'signature':
        return { signatureName: '', signatureTitle: '' };
      default:
        return { text: '' };
    }
  };

  const updateBlock = (index: number, updates: Partial<DocumentBlock>) => {
    const updated = [...blocks];
    updated[index] = { ...updated[index], ...updates };
    onBlocksChange(updated);
  };

  const deleteBlock = (index: number) => {
    const updated = blocks.filter((_, i) => i !== index);
    onBlocksChange(updated);
  };

  const moveBlock = (index: number, direction: 'up' | 'down') => {
    const updated = [...blocks];
    const newIndex = direction === 'up' ? index - 1 : index + 1;

    if (newIndex < 0 || newIndex >= updated.length) return;

    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    updated[index].order = index;
    updated[newIndex].order = newIndex;

    onBlocksChange(updated);
  };

  const renderBlockEditor = (block: DocumentBlock, index: number) => {
    switch (block.block_type) {
      case 'title':
      case 'subtitle':
      case 'paragraph':
        return (
          <div className="space-y-2">
            <textarea
              value={block.content.text || ''}
              onChange={(e) =>
                updateBlock(index, {
                  content: { ...block.content, text: e.target.value },
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              rows={block.block_type === 'paragraph' ? 4 : 2}
              placeholder="Text eingeben..."
            />
            <div className="flex items-center space-x-2">
              <select
                value={block.content.alignment || 'left'}
                onChange={(e) =>
                  updateBlock(index, {
                    content: { ...block.content, alignment: e.target.value as any },
                  })
                }
                className="px-2 py-1 border border-gray-300 rounded text-sm"
              >
                <option value="left">Links</option>
                <option value="center">Zentriert</option>
                <option value="right">Rechts</option>
                <option value="justify">Blocksatz</option>
              </select>
            </div>
          </div>
        );

      case 'spacer':
        return (
          <div>
            <label className="block text-sm text-gray-600 mb-1">Höhe (px)</label>
            <input
              type="number"
              value={parseInt(block.content.height || '20')}
              onChange={(e) =>
                updateBlock(index, {
                  content: { ...block.content, height: `${e.target.value}px` },
                })
              }
              className="w-32 px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
              min="10"
              max="100"
            />
          </div>
        );

      case 'date_place':
        return (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Ort</label>
              <input
                type="text"
                value={block.content.city || ''}
                onChange={(e) =>
                  updateBlock(index, {
                    content: { ...block.content, city: e.target.value },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                placeholder="z.B. Berlin"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Datum</label>
              <input
                type="date"
                value={block.content.date || ''}
                onChange={(e) =>
                  updateBlock(index, {
                    content: { ...block.content, date: e.target.value },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        );

      case 'signature':
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input
                type="text"
                value={block.content.signatureName || ''}
                onChange={(e) =>
                  updateBlock(index, {
                    content: { ...block.content, signatureName: e.target.value },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                placeholder="Vollständiger Name"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Titel/Position</label>
              <input
                type="text"
                value={block.content.signatureTitle || ''}
                onChange={(e) =>
                  updateBlock(index, {
                    content: { ...block.content, signatureTitle: e.target.value },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                placeholder="z.B. Geschäftsführer"
              />
            </div>
          </div>
        );

      default:
        return <div className="text-sm text-gray-500">Blocktyp wird nicht unterstützt</div>;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Inhaltsblöcke</h3>
        <div className="relative">
          <button
            onClick={() => setShowBlockMenu(!showBlockMenu)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center space-x-2"
          >
            <Plus size={18} />
            <span>Block hinzufügen</span>
          </button>

          {showBlockMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowBlockMenu(false)} />
              <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
                {blockTypes.map(({ type, icon: Icon, label }) => (
                  <button
                    key={type}
                    onClick={() => addBlock(type)}
                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-3"
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {blocks.length === 0 ? (
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
          <AlignLeft size={48} className="text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600 mb-4">Noch keine Inhaltsblöcke vorhanden</p>
          <button
            onClick={() => setShowBlockMenu(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center space-x-2 mx-auto"
          >
            <Plus size={18} />
            <span>Ersten Block hinzufügen</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {blocks.map((block, index) => (
            <div
              key={block.id}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start space-x-3">
                <div className="flex flex-col space-y-1 mt-2">
                  <GripVertical size={18} className="text-gray-400 cursor-move" />
                </div>

                <div className="flex-1">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-gray-700">
                      {BLOCK_TYPE_LABELS[block.block_type]}
                    </span>
                    <div className="flex items-center space-x-1">
                      {index > 0 && (
                        <button
                          onClick={() => moveBlock(index, 'up')}
                          className="p-1 text-gray-400 hover:text-gray-600"
                          title="Nach oben"
                        >
                          ▲
                        </button>
                      )}
                      {index < blocks.length - 1 && (
                        <button
                          onClick={() => moveBlock(index, 'down')}
                          className="p-1 text-gray-400 hover:text-gray-600"
                          title="Nach unten"
                        >
                          ▼
                        </button>
                      )}
                      <button
                        onClick={() => deleteBlock(index)}
                        className="p-1 text-red-600 hover:text-red-700"
                        title="Löschen"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  {renderBlockEditor(block, index)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {variables.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-blue-900 mb-2">Verfügbare Variablen</h4>
          <div className="flex flex-wrap gap-2">
            {variables.map((variable) => (
              <code
                key={variable}
                className="px-2 py-1 bg-white border border-blue-300 rounded text-sm text-blue-700 cursor-pointer hover:bg-blue-100"
                onClick={() => {
                  navigator.clipboard.writeText(`{{${variable}}}`);
                }}
                title="Klicken zum Kopieren"
              >
                {`{{${variable}}}`}
              </code>
            ))}
          </div>
          <p className="text-xs text-blue-700 mt-2">
            Klicken Sie auf eine Variable, um sie zu kopieren und in Textfeldern einzufügen
          </p>
        </div>
      )}
    </div>
  );
};

export default DocumentBuilder;
