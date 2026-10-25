/**
 * The words of the two mails a driver receives, in the three languages.
 *
 * Pure: no Deno, `npm:` or `jsr:` import. It lives here and not in `src/i18n`
 * because the edge functions cannot import from `src/`; the dictionaries there
 * are the UI's and this table is the mail's.
 *
 * ─── Shape ───────────────────────────────────────────────────────────────────
 *
 * Every entry is a plain sentence with `{token}` holes, never a function. The
 * mail builder fills the holes twice, once for HTML (escaped, with a direction
 * wrapper in Arabic) and once for plain text, so a translator edits sentences and
 * never touches escaping or bidirectional markup.
 *
 * **`Record<MailLanguage, DriverMailCopy>` is the completeness check**: a language
 * added to `MAIL_LANGUAGES` without a table, or a field added to the type without
 * a translation, fails to compile, and `driver-mail-copy.test.ts` fails the build
 * when the three tables name different `{tokens}` for the same sentence.
 *
 * ─── What is not translated ──────────────────────────────────────────────────
 *
 * The figures and dates (`506,95 €`, `31.08.2026 – 06.09.2026`) arrive formatted
 * German and stay that way: they map one-to-one onto the company's German
 * payroll documents. Names are the driver's and the company's own. The German
 * table reproduces the wording the mails had before the language existed, word
 * for word, so a company that sets `de` gets the mail it always got.
 *
 * The company-facing mails (the manager summary) are not here: they stay German.
 */
import type { MailLanguage } from './mail-language.ts';

export interface DriverMailCopy {
  hello: string;
  /** Footer lines of the shared layout. */
  footer: readonly [string, string];
  abrechnung: {
    intro: string;
    cash: string;
    belege: string;
    owes: string;
    credit: string;
    tankenquote: string;
    imageNote: string;
    sources: string;
    subject: string;
    heading: string;
    preheader: string;
    note: string;
  };
  reminder: {
    intro: string;
    missing: string;
    when: string;
    ignore: string;
    /** `HH:MM` as the schedule stores it, made into a time of day. */
    clock: string;
    subject: string;
    heading: string;
    preheader: string;
    note: string;
  };
}

const DE: DriverMailCopy = {
  hello: 'Hallo {name},',
  footer: [
    'El-Professor · Lohn- und Planungsverwaltung für Taxi- und Mietwagenunternehmen',
    'Diese E-Mail wurde automatisch versendet. Antworten auf diese Adresse werden nicht gelesen.',
  ],
  abrechnung: {
    intro: 'hier ist deine Abrechnung für {label} ({range}).',
    cash: 'Bargeld eingenommen',
    belege: 'Belege ({count})',
    owes: 'Abzugeben',
    credit: 'Guthaben',
    tankenquote: 'Tankenquote',
    imageNote: 'Die Übersicht hängt dieser E-Mail auch als Bild an.',
    sources: 'Die Zahlen stammen aus den Aufzeichnungen von {company}. Bei Fragen wende dich bitte an das Büro.',
    subject: 'Abrechnung {label} – {company}',
    heading: 'Abrechnung {label}',
    preheader: 'Deine Abrechnung für {range}',
    note: 'Diese E-Mail wurde automatisch aus dem Abrechnungssystem Ihres Unternehmens erstellt. '
      + 'Sie ist eine Übersicht, keine Rechnung und keine Zahlungsaufforderung.',
  },
  reminder: {
    intro: 'das ist eine Erinnerung zur Abrechnung für {label} ({range}).',
    missing: 'Für diese Woche hast du bisher weder Bargeld noch Barbelege erfasst.',
    when: 'Um {clock} verschickt {company} die Abrechnung für diese Woche automatisch per E-Mail. '
      + 'Wenn du noch etwas einzutragen hast, mach das bitte vor {clock}, sonst fehlt es in den Zahlen.',
    ignore: 'Hast du nichts abzugeben oder einzutragen, kannst du diese E-Mail einfach ignorieren.',
    clock: '{time} Uhr',
    subject: 'Erinnerung: Abrechnung {label} – {company}',
    heading: 'Erinnerung zur Abrechnung',
    preheader: 'Die Abrechnung für {range} geht um {clock} raus',
    note: 'Diese E-Mail wurde automatisch aus dem Abrechnungssystem Ihres Unternehmens erstellt. '
      + 'Sie ist eine Erinnerung, keine Rechnung und keine Zahlungsaufforderung.',
  },
};

const EN: DriverMailCopy = {
  hello: 'Hello {name},',
  footer: [
    'El-Professor · Payroll and planning management for taxi and rental-car companies',
    'This email was sent automatically. Replies to this address are not read.',
  ],
  abrechnung: {
    intro: 'here is your settlement for {label} ({range}).',
    cash: 'Cash collected',
    belege: 'Receipts ({count})',
    owes: 'To hand in',
    credit: 'Credit',
    tankenquote: 'Fuel share',
    imageNote: 'The overview is also attached to this email as an image.',
    sources: 'The figures come from the records of {company}. If you have any questions, please contact the office.',
    subject: 'Settlement {label} – {company}',
    heading: 'Settlement {label}',
    preheader: 'Your settlement for {range}',
    note: "This email was generated automatically by your company's settlement system. "
      + 'It is an overview, not an invoice and not a request for payment.',
  },
  reminder: {
    intro: 'this is a reminder about the settlement for {label} ({range}).',
    missing: 'So far you have recorded neither cash nor cash receipts for this week.',
    when: 'At {clock}, {company} sends out the settlement for this week by email automatically. '
      + 'If you still have something to enter, please do so before {clock}, otherwise it will be missing from the figures.',
    ignore: 'If you have nothing to hand in or enter, you can simply ignore this email.',
    clock: '{time}',
    subject: 'Reminder: settlement {label} – {company}',
    heading: 'Settlement reminder',
    preheader: 'The settlement for {range} goes out at {clock}',
    note: "This email was generated automatically by your company's settlement system. "
      + 'It is a reminder, not an invoice and not a request for payment.',
  },
};

const AR: DriverMailCopy = {
  hello: 'مرحبًا {name}،',
  footer: [
    'El-Professor · إدارة الرواتب والتخطيط لشركات سيارات الأجرة وسيارات الإيجار بسائق',
    'أُرسلت هذه الرسالة تلقائيًا. لا تتم قراءة الردود على هذا العنوان.',
  ],
  abrechnung: {
    intro: 'إليك كشف حسابك عن {label} ({range}).',
    cash: 'النقد المحصَّل',
    belege: 'الإيصالات ({count})',
    owes: 'المطلوب تسليمه',
    credit: 'الرصيد المستحق لك',
    tankenquote: 'نسبة الوقود',
    imageNote: 'الملخص مرفق بهذه الرسالة أيضًا كصورة.',
    sources: 'الأرقام مأخوذة من سجلات {company}. إذا كانت لديك أي أسئلة، يرجى التواصل مع المكتب.',
    subject: 'كشف الحساب {label} – {company}',
    heading: 'كشف الحساب {label}',
    preheader: 'كشف حسابك عن الفترة {range}',
    note: 'أُنشئت هذه الرسالة تلقائيًا من نظام المحاسبة في شركتك. '
      + 'وهي ملخص فقط، وليست فاتورة ولا طلب دفع.',
  },
  reminder: {
    intro: 'هذا تذكير بخصوص كشف الحساب عن {label} ({range}).',
    missing: 'لم تسجّل حتى الآن أي نقد أو إيصالات نقدية لهذا الأسبوع.',
    when: 'في الساعة {clock} تُرسل {company} كشف حساب هذا الأسبوع تلقائيًا بالبريد الإلكتروني. '
      + 'إذا كان لديك ما تسجّله، فيرجى فعل ذلك قبل الساعة {clock}، وإلا فلن يظهر في الأرقام.',
    ignore: 'إذا لم يكن لديك ما تسلّمه أو تسجّله، يمكنك ببساطة تجاهل هذه الرسالة.',
    clock: '{time}',
    subject: 'تذكير: كشف الحساب {label} – {company}',
    heading: 'تذكير بكشف الحساب',
    preheader: 'يصدر كشف الحساب عن الفترة {range} في الساعة {clock}',
    note: 'أُنشئت هذه الرسالة تلقائيًا من نظام المحاسبة في شركتك. '
      + 'وهي تذكير فقط، وليست فاتورة ولا طلب دفع.',
  },
};

export const DRIVER_MAIL_COPY: Record<MailLanguage, DriverMailCopy> = { de: DE, en: EN, ar: AR };

// ─── Filling the holes ───────────────────────────────────────────────────────

/**
 * Replaces each `{token}` with its entry in `values`, passing the literal text
 * between the holes through `literal` (HTML escaping, or nothing for plain text).
 * A token with no value throws: a sentence with a hole left in it must never be
 * mailed to a driver.
 */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  literal: (text: string) => string,
): string {
  return template
    .split(/(\{[a-zA-Z]+\})/)
    .map((part) => {
      const token = /^\{([a-zA-Z]+)\}$/.exec(part);
      if (!token) return literal(part);
      const value = values[token[1]];
      if (value === undefined) throw new Error(`driver mail copy: no value for {${token[1]}}`);
      return value;
    })
    .join('');
}

/** The `{tokens}` a sentence names, for the test that keeps the tables in step. */
export function tokensOf(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
}

// ─── The week label ──────────────────────────────────────────────────────────

const MONTHS: Record<'en' | 'ar', Record<string, string>> = {
  en: {
    Januar: 'January', Februar: 'February', 'März': 'March', April: 'April', Mai: 'May', Juni: 'June',
    Juli: 'July', August: 'August', September: 'September', Oktober: 'October',
    November: 'November', Dezember: 'December',
  },
  ar: {
    Januar: 'يناير', Februar: 'فبراير', 'März': 'مارس', April: 'أبريل', Mai: 'مايو', Juni: 'يونيو',
    Juli: 'يوليو', August: 'أغسطس', September: 'سبتمبر', Oktober: 'أكتوبر',
    November: 'نوفمبر', Dezember: 'ديسمبر',
  },
};

const WEEK_WORD: Record<'en' | 'ar', string> = { en: 'Week', ar: 'الأسبوع' };

/**
 * The period label, as the screen and the schedule write it in German
 * ("Woche 5 - August 2026"), in the driver's language.
 *
 * Only the word "Woche" and the month name are translated; the number and the
 * year are the label's own, and a label of any other shape is returned as it is
 * rather than guessed at. German is returned untouched.
 */
export function localizePeriodLabel(label: string, language: MailLanguage): string {
  if (language === 'de') return label;
  const months = MONTHS[language];
  return label
    .replace(/^Woche(?=\s+\d)/, WEEK_WORD[language])
    .replace(/(?<![\p{L}])(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)(?![\p{L}])/gu,
      (name) => months[name] ?? name);
}
