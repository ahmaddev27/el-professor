import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import type { ReceiptDocumentText } from '../utils/salaryCashReceiptDocument';

/**
 * The Gehaltsquittung as one A4 sheet, rendered from ReceiptDocumentText.
 *
 * The same sheet is shown scaled as the preview and captured for the PDF, the
 * way TrinkgeldQuittungModal builds its Quittung: html2canvas draws it and
 * jsPDF places the image on an A4 page. Paper is white in both themes, so the
 * sheet sets its own colours instead of taking the design tokens, and every
 * word on it is German.
 */

const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

const caption: CSSProperties = {
  fontSize: '9px',
  color: '#666',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: '3px',
};

const rule = (weight: string, color: string, margin: string): CSSProperties => ({
  borderTop: `${weight} solid ${color}`,
  margin,
});

export function GehaltsquittungSheet({ text }: { text: ReceiptDocumentText }) {
  return (
    <div
      style={{
        fontFamily: FONT,
        background: '#ffffff',
        color: '#1a1a1a',
        width: `${A4_WIDTH_PX}px`,
        minHeight: `${A4_HEIGHT_PX}px`,
        padding: '40px 56px 44px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {text.banner ? (
        <div
          style={{
            border: '2px dashed #1a1a1a',
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textAlign: 'center',
            padding: '6px 10px',
            marginBottom: '18px',
          }}
        >
          {text.banner}
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#111', lineHeight: 1.25 }}>{text.company.name}</div>
          {text.company.addressLines.map(line => (
            <div key={line} style={{ fontSize: '11px', color: '#444', lineHeight: 1.6 }}>
              {line}
            </div>
          ))}
        </div>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#111', whiteSpace: 'nowrap' }}>{text.number}</div>
      </div>

      <div style={rule('1.5px', '#222', '20px 0 24px')} />

      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <div style={{ fontSize: '26px', fontWeight: 800, color: '#111', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          {text.title}
        </div>
        <div style={{ fontSize: '13px', color: '#555', marginTop: '6px' }}>{text.subtitle}</div>
      </div>

      <div style={{ fontSize: '11px', lineHeight: 1.6, marginBottom: '16px' }}>
        <div style={{ color: '#666', marginBottom: '4px' }}>{text.parties.between}</div>
        <div style={{ fontWeight: 700, fontSize: '13px', color: '#111' }}>{text.parties.employee}</div>
        <div style={{ color: '#666', fontSize: '10px', marginBottom: '8px' }}>{text.parties.employeeNote}</div>
        <div style={{ color: '#666', marginBottom: '4px' }}>{text.parties.and}</div>
        <div style={{ fontWeight: 700, fontSize: '13px', color: '#111' }}>{text.parties.employer}</div>
        <div style={{ color: '#666', fontSize: '10px' }}>{text.parties.employerNote}</div>
      </div>

      <div style={rule('1px', '#ddd', '0 0 16px')} />

      <p style={{ fontSize: '11.5px', lineHeight: 1.7, color: '#333', margin: '0 0 16px' }}>{text.confirmation}</p>

      <div style={{ display: 'flex', border: '1px solid #d9d9d9', background: '#f5f5f5', borderRadius: '8px', marginBottom: '18px' }}>
        <div style={{ flex: '1.4 1 0', padding: '12px 18px', borderRight: '1px solid #d9d9d9' }}>
          <div style={caption}>{text.amount.label}</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#111' }}>{text.amount.figures}</div>
          <div style={{ fontSize: '10px', color: '#444', marginTop: '3px', overflowWrap: 'anywhere' }}>{text.amount.words}</div>
        </div>
        {text.facts.map(fact => (
          <div key={fact.label} style={{ flex: '1 1 0', padding: '12px 18px', borderRight: '1px solid #d9d9d9' }}>
            <div style={caption}>{fact.label}</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#111' }}>{fact.value}</div>
          </div>
        ))}
      </div>

      {/* The salary-status table and the Teilzahlung sentence stood here until the
          owner's decision of 28.09.2026. The sheet now states the amount, the
          Abrechnungsmonat and the date of payment, and no balances at all — see
          the note in utils/salaryCashReceiptDocument.ts for what that costs. */}

      <div style={{ flex: 1, minHeight: '28px' }} />

      <div style={{ marginBottom: '44px' }}>
        <div style={caption}>{text.placeAndDate.label}</div>
        <div style={{ fontWeight: 600, fontSize: '12px', color: '#111' }}>{text.placeAndDate.value}</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '40px' }}>
        {[text.signatures.employee, text.signatures.employer].map(signature => (
          <div key={signature.caption} style={{ flex: 1, borderTop: '1px solid #555', paddingTop: '6px' }}>
            <div style={{ fontSize: '9.5px', color: '#666' }}>{signature.caption}</div>
            <div style={{ fontSize: '10px', color: '#333', marginTop: '2px' }}>{signature.name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The sheet scaled to the width it is given, so a phone shows the whole page
 * rather than a corner of it. The text stays real text for screen readers.
 */
export function GehaltsquittungPreview({ text, label }: { text: ReceiptDocumentText; label: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 0.5, height: A4_HEIGHT_PX / 2 });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const sheet = sheetRef.current;
    if (!frame || !sheet) return undefined;
    const measure = () => {
      const scale = frame.clientWidth / A4_WIDTH_PX;
      setSize({ scale, height: sheet.offsetHeight * scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, []);

  return (
    <figure aria-label={label} className="m-0 overflow-hidden rounded-control border border-line bg-white shadow-raised">
      <div ref={frameRef} style={{ height: `${size.height}px`, position: 'relative' }}>
        <div
          ref={sheetRef}
          style={{ position: 'absolute', top: 0, left: 0, transform: `scale(${size.scale})`, transformOrigin: 'top left' }}
        >
          <GehaltsquittungSheet text={text} />
        </div>
      </div>
    </figure>
  );
}

/** Renders the sheet off screen, captures it and saves it as a one-page A4 PDF. */
export async function exportGehaltsquittungPdf(text: ReceiptDocumentText): Promise<void> {
  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-10000px;top:0;width:${A4_WIDTH_PX}px;`;
  document.body.appendChild(container);

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);

  try {
    await new Promise<void>(resolve => {
      root.render(<GehaltsquittungSheet text={text} />);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const sheet = container.firstElementChild;
    if (!(sheet instanceof HTMLElement)) throw new Error('Gehaltsquittung sheet did not render');

    const canvas = await html2canvas(sheet, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      width: A4_WIDTH_PX,
      windowWidth: A4_WIDTH_PX,
    });

    // Fit the page rather than stretch to it, so a sheet that ran longer than
    // A4 is shrunk, never cut off or distorted.
    const pageWidth = 210;
    const pageHeight = 297;
    const fullWidthHeight = (canvas.height / canvas.width) * pageWidth;
    const width = fullWidthHeight <= pageHeight ? pageWidth : (canvas.width / canvas.height) * pageHeight;
    const height = Math.min(fullWidthHeight, pageHeight);

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    pdf.setProperties({ title: `${text.title} ${text.number}` });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.97), 'JPEG', (pageWidth - width) / 2, 0, width, height);
    pdf.save(`${text.fileName}.pdf`);
  } finally {
    root.unmount();
    container.remove();
  }
}
