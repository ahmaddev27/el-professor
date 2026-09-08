export type DocumentSourceType = 'uploaded' | 'template' | 'generated';
export type DocumentStatus = 'draft' | 'active' | 'archived';
export type VariableType = 'text' | 'multiline' | 'date' | 'number' | 'currency' | 'boolean' | 'email' | 'phone' | 'signature';
export type VariableSource = 'manual' | 'company' | 'driver' | 'payroll' | 'vehicle' | 'system';
export type BlockType = 'title' | 'subtitle' | 'paragraph' | 'richtext' | 'table' | 'image' | 'logo' | 'spacer' | 'divider' | 'date_place' | 'signature' | 'header' | 'footer';

export interface Document {
  id: string;
  title: string;
  description: string | null;
  category: string;
  source_type: DocumentSourceType;
  status: DocumentStatus;
  file_url: string | null;
  file_type: string | null;
  file_size: number | null;
  content: DocumentBlock[];
  include_header: boolean;
  include_footer: boolean;
  include_signature: boolean;
  include_company_logo: boolean;
  include_company_info: boolean;
  preview_image_url: string | null;
  is_pinned: boolean;
  parent_template_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentVariable {
  id: string;
  document_id: string;
  label: string;
  key: string;
  variable_type: VariableType;
  source: VariableSource;
  required: boolean;
  default_value: string | null;
  value: string | null;
  description: string | null;
  order: number;
  created_at: string;
}

export interface DocumentBlock {
  id: string;
  document_id: string;
  block_type: BlockType;
  content: BlockContent;
  order: number;
  created_at: string;
  updated_at: string;
}

export interface BlockContent {
  text?: string;
  html?: string;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  fontSize?: string;
  fontWeight?: 'normal' | 'bold';
  color?: string;
  rows?: TableRow[];
  imageUrl?: string;
  imageAlt?: string;
  imageWidth?: string;
  height?: string;
  city?: string;
  date?: string;
  signatureName?: string;
  signatureTitle?: string;
  [key: string]: any;
}

export interface TableRow {
  cells: string[];
}

export interface DocumentCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  order: number;
  created_at: string;
}

export interface DocumentWithRelations extends Document {
  variables?: DocumentVariable[];
  blocks?: DocumentBlock[];
  category_info?: DocumentCategory;
}

export interface CreateDocumentData {
  title: string;
  description?: string;
  category: string;
  source_type: DocumentSourceType;
  status?: DocumentStatus;
  file_url?: string;
  file_type?: string;
  file_size?: number;
  content?: DocumentBlock[];
  include_header?: boolean;
  include_footer?: boolean;
  include_signature?: boolean;
  include_company_logo?: boolean;
  include_company_info?: boolean;
  parent_template_id?: string;
}

export interface UpdateDocumentData extends Partial<CreateDocumentData> {
  id: string;
}

export interface CreateVariableData {
  document_id: string;
  label: string;
  key: string;
  variable_type: VariableType;
  source: VariableSource;
  required?: boolean;
  default_value?: string;
  value?: string;
  description?: string;
  order?: number;
}

export interface CreateBlockData {
  document_id: string;
  block_type: BlockType;
  content: BlockContent;
  order: number;
}

export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  title: 'Titel',
  subtitle: 'Untertitel',
  paragraph: 'Absatz',
  richtext: 'Formatierter Text',
  table: 'Tabelle',
  image: 'Bild',
  logo: 'Logo',
  spacer: 'Abstand',
  divider: 'Trennlinie',
  date_place: 'Ort und Datum',
  signature: 'Unterschrift',
  header: 'Kopfzeile',
  footer: 'Fußzeile',
};

export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  text: 'Text',
  multiline: 'Mehrzeiliger Text',
  date: 'Datum',
  number: 'Zahl',
  currency: 'Währung',
  boolean: 'Ja/Nein',
  email: 'E-Mail',
  phone: 'Telefon',
  signature: 'Unterschrift',
};

export const VARIABLE_SOURCE_LABELS: Record<VariableSource, string> = {
  manual: 'Manuelle Eingabe',
  company: 'Firmeneinstellungen',
  driver: 'Fahrerdaten',
  payroll: 'Gehaltsdaten',
  vehicle: 'Fahrzeugdaten',
  system: 'System',
};

export const DEFAULT_CATEGORIES = [
  'Allgemein',
  'Vorlagen',
  'Verträge',
  'Fahrer',
  'Gehalt',
  'Abrechnung',
  'Rechnung',
  'Bescheinigung',
  'Intern',
];
