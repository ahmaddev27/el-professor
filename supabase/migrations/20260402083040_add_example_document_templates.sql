/*
  # Add example document templates

  This migration creates starter templates for common documents
  that users can duplicate and customize.

  1. Templates Created
    - Fahrervertrag (Driver contract)
    - Bescheinigung (Certificate)
    - Gehaltsabrechnung (Salary statement)

  2. Security
    - Templates are created with a system user
    - All users can view and duplicate templates
*/

-- Insert example templates (using first admin user as creator)
DO $$
DECLARE
  admin_user_id uuid;
  vertrag_id uuid;
  bescheinigung_id uuid;
  gehalt_id uuid;
BEGIN
  -- Get first admin user
  SELECT user_id INTO admin_user_id
  FROM user_profiles
  WHERE role = 'admin'
  LIMIT 1;

  -- If no admin found, skip
  IF admin_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Create Fahrervertrag template
  INSERT INTO documents (
    title,
    description,
    category,
    source_type,
    status,
    include_header,
    include_footer,
    include_signature,
    include_company_logo,
    include_company_info,
    created_by
  ) VALUES (
    'Fahrervertrag Vorlage',
    'Standardvertrag für neue Fahrer mit allen wichtigen Vertragsbedingungen',
    'Verträge',
    'template',
    'active',
    true,
    true,
    true,
    true,
    true,
    admin_user_id
  ) RETURNING id INTO vertrag_id;

  -- Add blocks for Fahrervertrag
  INSERT INTO document_blocks (document_id, block_type, content, "order") VALUES
    (vertrag_id, 'title', '{"text": "Fahrervertrag", "fontSize": "24px", "fontWeight": "bold", "alignment": "center"}', 0),
    (vertrag_id, 'spacer', '{"height": "30px"}', 1),
    (vertrag_id, 'paragraph', '{"text": "zwischen {{company_name}}, nachfolgend \"Arbeitgeber\" genannt,", "alignment": "left"}', 2),
    (vertrag_id, 'paragraph', '{"text": "und Herrn/Frau {{driver_name}}, nachfolgend \"Arbeitnehmer\" genannt,", "alignment": "left"}', 3),
    (vertrag_id, 'spacer', '{"height": "20px"}', 4),
    (vertrag_id, 'paragraph', '{"text": "wird folgender Arbeitsvertrag geschlossen:", "alignment": "left"}', 5),
    (vertrag_id, 'spacer', '{"height": "20px"}', 6),
    (vertrag_id, 'subtitle', '{"text": "§1 Beginn und Art der Tätigkeit", "fontSize": "16px", "fontWeight": "bold", "alignment": "left"}', 7),
    (vertrag_id, 'paragraph', '{"text": "Der Arbeitnehmer wird ab dem {{start_date}} als Fahrer eingestellt. Die Probezeit beträgt 3 Monate.", "alignment": "left"}', 8),
    (vertrag_id, 'spacer', '{"height": "20px"}', 9),
    (vertrag_id, 'subtitle', '{"text": "§2 Vergütung", "fontSize": "16px", "fontWeight": "bold", "alignment": "left"}', 10),
    (vertrag_id, 'paragraph', '{"text": "Die monatliche Bruttovergütung beträgt {{salary_amount}} EUR und wird am Ende eines jeden Monats ausgezahlt.", "alignment": "left"}', 11),
    (vertrag_id, 'spacer', '{"height": "40px"}', 12),
    (vertrag_id, 'date_place', '{"city": "", "date": ""}', 13),
    (vertrag_id, 'spacer', '{"height": "40px"}', 14),
    (vertrag_id, 'signature', '{"signatureName": "", "signatureTitle": "Geschäftsführer"}', 15);

  -- Add variables for Fahrervertrag
  INSERT INTO document_variables (document_id, label, key, variable_type, source, required, "order") VALUES
    (vertrag_id, 'Firmenname', 'company_name', 'text', 'company', true, 0),
    (vertrag_id, 'Fahrer Name', 'driver_name', 'text', 'driver', true, 1),
    (vertrag_id, 'Startdatum', 'start_date', 'date', 'manual', true, 2),
    (vertrag_id, 'Gehalt Betrag', 'salary_amount', 'currency', 'payroll', true, 3);

  -- Create Bescheinigung template
  INSERT INTO documents (
    title,
    description,
    category,
    source_type,
    status,
    include_header,
    include_footer,
    include_signature,
    include_company_logo,
    include_company_info,
    created_by
  ) VALUES (
    'Bescheinigung Vorlage',
    'Allgemeine Bescheinigung für Fahrer',
    'Bescheinigung',
    'template',
    'active',
    true,
    true,
    true,
    true,
    true,
    admin_user_id
  ) RETURNING id INTO bescheinigung_id;

  -- Add blocks for Bescheinigung
  INSERT INTO document_blocks (document_id, block_type, content, "order") VALUES
    (bescheinigung_id, 'title', '{"text": "Bescheinigung", "fontSize": "24px", "fontWeight": "bold", "alignment": "center"}', 0),
    (bescheinigung_id, 'spacer', '{"height": "40px"}', 1),
    (bescheinigung_id, 'paragraph', '{"text": "Hiermit bestätigen wir, dass Herr/Frau {{driver_name}}, geboren am {{birth_date}}, im Zeitraum vom {{period_start}} bis {{period_end}} für unser Unternehmen als Fahrer tätig war.", "alignment": "justify"}', 2),
    (bescheinigung_id, 'spacer', '{"height": "20px"}', 3),
    (bescheinigung_id, 'paragraph', '{"text": "Die Tätigkeit wurde stets zu unserer vollsten Zufriedenheit ausgeführt.", "alignment": "justify"}', 4),
    (bescheinigung_id, 'spacer', '{"height": "20px"}', 5),
    (bescheinigung_id, 'paragraph', '{"text": "Wir wünschen für die Zukunft alles Gute und viel Erfolg.", "alignment": "justify"}', 6),
    (bescheinigung_id, 'spacer', '{"height": "40px"}', 7),
    (bescheinigung_id, 'date_place', '{"city": "", "date": ""}', 8),
    (bescheinigung_id, 'spacer', '{"height": "40px"}', 9),
    (bescheinigung_id, 'signature', '{"signatureName": "", "signatureTitle": "Geschäftsführer"}', 10);

  -- Add variables for Bescheinigung
  INSERT INTO document_variables (document_id, label, key, variable_type, source, required, "order") VALUES
    (bescheinigung_id, 'Fahrer Name', 'driver_name', 'text', 'driver', true, 0),
    (bescheinigung_id, 'Geburtsdatum', 'birth_date', 'date', 'driver', false, 1),
    (bescheinigung_id, 'Zeitraum Start', 'period_start', 'date', 'manual', true, 2),
    (bescheinigung_id, 'Zeitraum Ende', 'period_end', 'date', 'manual', true, 3);

  -- Create Gehaltsabrechnung template
  INSERT INTO documents (
    title,
    description,
    category,
    source_type,
    status,
    include_header,
    include_footer,
    include_signature,
    include_company_logo,
    include_company_info,
    created_by
  ) VALUES (
    'Gehaltsabrechnung Vorlage',
    'Monatliche Gehaltsabrechnung für Fahrer',
    'Gehalt',
    'template',
    'active',
    true,
    true,
    false,
    true,
    true,
    admin_user_id
  ) RETURNING id INTO gehalt_id;

  -- Add blocks for Gehaltsabrechnung
  INSERT INTO document_blocks (document_id, block_type, content, "order") VALUES
    (gehalt_id, 'title', '{"text": "Gehaltsabrechnung", "fontSize": "24px", "fontWeight": "bold", "alignment": "center"}', 0),
    (gehalt_id, 'spacer', '{"height": "30px"}', 1),
    (gehalt_id, 'paragraph', '{"text": "Mitarbeiter: {{driver_name}}", "alignment": "left"}', 2),
    (gehalt_id, 'paragraph', '{"text": "Abrechnungszeitraum: {{period_month}}", "alignment": "left"}', 3),
    (gehalt_id, 'spacer', '{"height": "30px"}', 4),
    (gehalt_id, 'subtitle', '{"text": "Abrechnungsdetails", "fontSize": "16px", "fontWeight": "bold", "alignment": "left"}', 5),
    (gehalt_id, 'paragraph', '{"text": "Brutto-Gehalt: {{gross_salary}} EUR", "alignment": "left"}', 6),
    (gehalt_id, 'paragraph', '{"text": "Abzüge gesamt: {{deductions}} EUR", "alignment": "left"}', 7),
    (gehalt_id, 'paragraph', '{"text": "Netto-Gehalt: {{net_salary}} EUR", "alignment": "left"}', 8),
    (gehalt_id, 'spacer', '{"height": "40px"}', 9),
    (gehalt_id, 'paragraph', '{"text": "Der Betrag wird auf das hinterlegte Konto überwiesen.", "alignment": "left"}', 10);

  -- Add variables for Gehaltsabrechnung
  INSERT INTO document_variables (document_id, label, key, variable_type, source, required, "order") VALUES
    (gehalt_id, 'Fahrer Name', 'driver_name', 'text', 'driver', true, 0),
    (gehalt_id, 'Abrechnungsmonat', 'period_month', 'text', 'manual', true, 1),
    (gehalt_id, 'Brutto-Gehalt', 'gross_salary', 'currency', 'payroll', true, 2),
    (gehalt_id, 'Abzüge', 'deductions', 'currency', 'payroll', true, 3),
    (gehalt_id, 'Netto-Gehalt', 'net_salary', 'currency', 'payroll', true, 4);

END $$;
