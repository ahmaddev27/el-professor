import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type {
  Document,
  DocumentVariable,
  DocumentBlock,
  DocumentCategory,
  DocumentWithRelations,
  CreateDocumentData,
  UpdateDocumentData,
  CreateVariableData,
  CreateBlockData,
  DocumentSourceType,
  DocumentStatus,
} from '../types/document';

export const useDocuments = () => {
  const { companyId } = useAuth();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [categories, setCategories] = useState<DocumentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDocuments();
    fetchCategories();
  }, []);

  const fetchDocuments = async (filters?: {
    source_type?: DocumentSourceType;
    status?: DocumentStatus;
    category?: string;
    search?: string;
  }) => {
    try {
      setLoading(true);
      setError(null);

      let query = supabase
        .from('documents')
        .select('*')
        .eq('company_id', companyId)
        .order('updated_at', { ascending: false });

      if (filters?.source_type) {
        query = query.eq('source_type', filters.source_type);
      }
      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.category) {
        query = query.eq('category', filters.category);
      }
      if (filters?.search) {
        query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
      }

      const { data, error: fetchError } = await query;

      if (fetchError) throw fetchError;
      setDocuments(data || []);
    } catch (err: any) {
      console.error('Error fetching documents:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchDocumentById = async (id: string): Promise<DocumentWithRelations | null> => {
    try {
      const { data: doc, error: docError } = await supabase
        .from('documents')
        .select('*')
        .eq('id', id)
        .single();

      if (docError) throw docError;

      const { data: variables } = await supabase
        .from('document_variables')
        .select('*')
        .eq('document_id', id)
        .order('order');

      const { data: blocks } = await supabase
        .from('document_blocks')
        .select('*')
        .eq('document_id', id)
        .order('order');

      return {
        ...doc,
        variables: variables || [],
        blocks: blocks || [],
      };
    } catch (err: any) {
      console.error('Error fetching document:', err);
      throw err;
    }
  };

  const fetchCategories = async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('document_categories')
        .select('*')
        .order('order');

      if (fetchError) throw fetchError;
      setCategories(data || []);
    } catch (err: any) {
      console.error('Error fetching categories:', err);
    }
  };

  const createDocument = async (data: CreateDocumentData): Promise<Document> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: doc, error: createError } = await supabase
        .from('documents')
        .insert({
          ...data,
          created_by: user.id,
          company_id: companyId,
        })
        .select()
        .single();

      if (createError) throw createError;

      await fetchDocuments();
      return doc;
    } catch (err: any) {
      console.error('Error creating document:', err);
      throw err;
    }
  };

  const updateDocument = async (data: UpdateDocumentData): Promise<void> => {
    try {
      const { id, ...updates } = data;

      const { error: updateError } = await supabase
        .from('documents')
        .update(updates)
        .eq('id', id);

      if (updateError) throw updateError;

      await fetchDocuments();
    } catch (err: any) {
      console.error('Error updating document:', err);
      throw err;
    }
  };

  const deleteDocument = async (id: string): Promise<void> => {
    try {
      const { error: deleteError } = await supabase
        .from('documents')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;

      await fetchDocuments();
    } catch (err: any) {
      console.error('Error deleting document:', err);
      throw err;
    }
  };

  const duplicateDocument = async (id: string): Promise<Document> => {
    try {
      const original = await fetchDocumentById(id);
      if (!original) throw new Error('Document not found');

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: newDoc, error: createError } = await supabase
        .from('documents')
        .insert({
          title: `${original.title} (Kopie)`,
          description: original.description,
          category: original.category,
          source_type: original.source_type,
          status: 'draft',
          content: original.content,
          include_header: original.include_header,
          include_footer: original.include_footer,
          include_signature: original.include_signature,
          include_company_logo: original.include_company_logo,
          include_company_info: original.include_company_info,
          parent_template_id: original.id,
          created_by: user.id,
          company_id: companyId,
        })
        .select()
        .single();

      if (createError) throw createError;

      if (original.variables && original.variables.length > 0) {
        const variablesToInsert = original.variables.map(v => ({
          document_id: newDoc.id,
          label: v.label,
          key: v.key,
          variable_type: v.variable_type,
          source: v.source,
          required: v.required,
          default_value: v.default_value,
          description: v.description,
          order: v.order,
        }));

        await supabase.from('document_variables').insert(variablesToInsert);
      }

      if (original.blocks && original.blocks.length > 0) {
        const blocksToInsert = original.blocks.map(b => ({
          document_id: newDoc.id,
          block_type: b.block_type,
          content: b.content,
          order: b.order,
        }));

        await supabase.from('document_blocks').insert(blocksToInsert);
      }

      await fetchDocuments();
      return newDoc;
    } catch (err: any) {
      console.error('Error duplicating document:', err);
      throw err;
    }
  };

  const createVariable = async (data: CreateVariableData): Promise<DocumentVariable> => {
    try {
      const { data: variable, error: createError } = await supabase
        .from('document_variables')
        .insert(data)
        .select()
        .single();

      if (createError) throw createError;
      return variable;
    } catch (err: any) {
      console.error('Error creating variable:', err);
      throw err;
    }
  };

  const updateVariable = async (id: string, updates: Partial<DocumentVariable>): Promise<void> => {
    try {
      const { error: updateError } = await supabase
        .from('document_variables')
        .update(updates)
        .eq('id', id);

      if (updateError) throw updateError;
    } catch (err: any) {
      console.error('Error updating variable:', err);
      throw err;
    }
  };

  const deleteVariable = async (id: string): Promise<void> => {
    try {
      const { error: deleteError } = await supabase
        .from('document_variables')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;
    } catch (err: any) {
      console.error('Error deleting variable:', err);
      throw err;
    }
  };

  const createBlock = async (data: CreateBlockData): Promise<DocumentBlock> => {
    try {
      const { data: block, error: createError } = await supabase
        .from('document_blocks')
        .insert(data)
        .select()
        .single();

      if (createError) throw createError;
      return block;
    } catch (err: any) {
      console.error('Error creating block:', err);
      throw err;
    }
  };

  const updateBlock = async (id: string, updates: Partial<DocumentBlock>): Promise<void> => {
    try {
      const { error: updateError } = await supabase
        .from('document_blocks')
        .update(updates)
        .eq('id', id);

      if (updateError) throw updateError;
    } catch (err: any) {
      console.error('Error updating block:', err);
      throw err;
    }
  };

  const deleteBlock = async (id: string): Promise<void> => {
    try {
      const { error: deleteError } = await supabase
        .from('document_blocks')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;
    } catch (err: any) {
      console.error('Error deleting block:', err);
      throw err;
    }
  };

  const reorderBlocks = async (documentId: string, blockIds: string[]): Promise<void> => {
    try {
      const updates = blockIds.map((id, index) => ({
        id,
        order: index,
      }));

      for (const update of updates) {
        await supabase
          .from('document_blocks')
          .update({ order: update.order })
          .eq('id', update.id);
      }
    } catch (err: any) {
      console.error('Error reordering blocks:', err);
      throw err;
    }
  };

  const uploadFile = async (file: File, documentId?: string): Promise<string> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('documents')
        .getPublicUrl(fileName);

      return publicUrl;
    } catch (err: any) {
      console.error('Error uploading file:', err);
      throw err;
    }
  };

  return {
    documents,
    categories,
    loading,
    error,
    fetchDocuments,
    fetchDocumentById,
    createDocument,
    updateDocument,
    deleteDocument,
    duplicateDocument,
    createVariable,
    updateVariable,
    deleteVariable,
    createBlock,
    updateBlock,
    deleteBlock,
    reorderBlocks,
    uploadFile,
  };
};
