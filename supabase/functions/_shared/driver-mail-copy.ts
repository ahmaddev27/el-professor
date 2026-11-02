/**
 * The words of the two mails a driver receives, in the five languages.
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
 * when the tables name different `{tokens}` for the same sentence.
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
  /**
   * The greeting when the mail cannot name a person: an address two drivers of
   * one company share, so who reads it is unknown (`abrechnung-reminder-core.ts`).
   * Greeting the wrong one by name is worse than greeting nobody.
   */
  helloPlain: string;
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
    /**
     * The ask. It was `missing` — "you have recorded nothing this week" — until
     * 26.10.2026, when the reminder began going to every active driver and that
     * sentence became a claim the mail cannot make. It now asks for whatever is
     * outstanding and asserts nothing about what the driver has done.
     *
     * It asks for **receipts and nothing else** since 02.11.2026 (the owner, on a
     * reminder as it reached a driver): no Fahrtenbuch and no cash. The driver
     * uploads receipts; the office enters the rest. `ignore` and `when` follow it:
     * "handed in everything" and "anything that arrives later" ask for the same
     * things by another word, and he repeated that the mail is about receipts only.
     */
    handIn: string;
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
  helloPlain: 'Guten Tag,',
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
    note: 'Diese E-Mail wurde automatisch aus dem Abrechnungssystem deines Unternehmens erstellt. '
      + 'Sie ist eine Übersicht, keine Rechnung und keine Zahlungsaufforderung.',
  },
  reminder: {
    intro: 'das ist die wöchentliche Erinnerung zur Abrechnung für {label} ({range}).',
    handIn: 'Falls du für diese Woche noch Belege hast, lade sie bitte jetzt hoch.',
    when: 'Um {clock} verschickt {company} die Abrechnung für diese Woche automatisch per E-Mail. '
      + 'Belege, die danach hochgeladen werden, fehlen in den Zahlen.',
    ignore: 'Hast du für diese Woche schon alle Belege hochgeladen, kannst du diese E-Mail einfach ignorieren.',
    clock: '{time} Uhr',
    subject: 'Erinnerung: Abrechnung {label} – {company}',
    heading: 'Erinnerung zur Abrechnung',
    preheader: 'Die Abrechnung für {range} geht um {clock} raus',
    note: 'Diese E-Mail wurde automatisch aus dem Abrechnungssystem deines Unternehmens erstellt. '
      + 'Sie ist eine Erinnerung, keine Rechnung und keine Zahlungsaufforderung.',
  },
};

const EN: DriverMailCopy = {
  hello: 'Hello {name},',
  helloPlain: 'Hello,',
  footer: [
    'El-Professor · Payroll and planning management for taxi and rental-car companies',
    'This email was sent automatically. Replies to this address are not read.',
  ],
  abrechnung: {
    intro: 'here is your settlement for {label} ({range}).',
    cash: 'Cash collected',
    belege: 'Receipts ({count})',
    owes: 'To hand over',
    credit: 'Credit',
    tankenquote: 'Fuel cost share',
    imageNote: 'The overview is also attached to this email as an image.',
    sources: 'The figures come from the records of {company}. If you have any questions, please contact the office.',
    subject: 'Settlement {label} – {company}',
    heading: 'Settlement {label}',
    preheader: 'Your settlement for {range}',
    note: "This email was generated automatically by your company's settlement system. "
      + 'It is an overview, not an invoice and not a request for payment.',
  },
  reminder: {
    intro: 'this is the weekly reminder about the settlement for {label} ({range}).',
    handIn: 'If you still have receipts for this week, please upload them now.',
    when: 'At {clock}, {company} sends out the settlement for this week by email automatically. '
      + 'Receipts uploaded after that will not be in the figures.',
    ignore: 'If you have already uploaded all your receipts for this week, you can simply ignore this email.',
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
  helloPlain: 'مرحبًا،',
  footer: [
    'El-Professor · إدارة الرواتب والتخطيط لشركات سيارات الأجرة وسيارات الإيجار بسائق',
    'أُرسلت هذه الرسالة تلقائيًا. لا تُقرأ الردود المرسلة إلى هذا العنوان.',
  ],
  abrechnung: {
    intro: 'إليك كشف حسابك عن {label} ({range}).',
    cash: 'النقد المحصَّل',
    belege: 'الإيصالات ({count})',
    owes: 'المطلوب تسليمه',
    credit: 'الرصيد المستحق لك',
    tankenquote: 'نسبة تكلفة الوقود',
    imageNote: 'الملخص مرفق بهذه الرسالة أيضًا كصورة.',
    sources: 'الأرقام مأخوذة من سجلات {company}. إذا كانت لديك أي أسئلة، فيرجى التواصل مع المكتب.',
    subject: 'كشف الحساب: {label} – {company}',
    heading: 'كشف الحساب: {label}',
    preheader: 'كشف حسابك عن الفترة {range}',
    note: 'أُنشئت هذه الرسالة تلقائيًا من نظام المحاسبة في شركتك. '
      + 'وهي ملخص فقط، وليست فاتورة ولا طلب دفع.',
  },
  reminder: {
    intro: 'هذا هو التذكير الأسبوعي بخصوص كشف الحساب عن {label} ({range}).',
    handIn: 'إذا كانت لديك إيصالات عن هذا الأسبوع لم ترفعها بعد، فيرجى رفعها الآن.',
    when: 'في الساعة {clock} تُرسل {company} كشف حساب هذا الأسبوع تلقائيًا بالبريد الإلكتروني. '
      + 'والإيصالات التي تُرفع بعد ذلك لن تظهر في الأرقام.',
    ignore: 'إذا كنت قد رفعت كل إيصالاتك عن هذا الأسبوع، فيمكنك ببساطة تجاهل هذه الرسالة.',
    clock: '{time}',
    subject: 'تذكير بكشف الحساب: {label} – {company}',
    heading: 'تذكير بكشف الحساب',
    preheader: 'يصدر كشف الحساب عن الفترة {range} في الساعة {clock}',
    note: 'أُنشئت هذه الرسالة تلقائيًا من نظام المحاسبة في شركتك. '
      + 'وهي تذكير فقط، وليست فاتورة ولا طلب دفع.',
  },
};

const TR: DriverMailCopy = {
  hello: 'Merhaba {name},',
  helloPlain: 'Merhaba,',
  footer: [
    'El-Professor · Taksi ve şoförlü kiralık araç şirketleri için bordro ve planlama yönetimi',
    'Bu e-posta otomatik olarak gönderilmiştir. Bu adrese gönderilen yanıtlar okunmaz.',
  ],
  abrechnung: {
    intro: '{label} ({range}) dönemine ait hesap dökümünüz aşağıdadır.',
    cash: 'Tahsil edilen nakit',
    belege: 'Fişler ({count})',
    owes: 'Teslim edilecek tutar',
    credit: 'Alacağınız',
    tankenquote: 'Yakıt gideri oranı',
    imageNote: 'Özet, bu e-postaya görsel olarak da eklenmiştir.',
    sources: 'Rakamlar {company} kayıtlarından alınmıştır. Sorularınız için lütfen ofisle iletişime geçin.',
    subject: 'Hesap dökümü: {label} – {company}',
    heading: 'Hesap dökümü: {label}',
    preheader: '{range} dönemine ait hesap dökümünüz',
    note: 'Bu e-posta, şirketinizin muhasebe sistemi tarafından otomatik olarak oluşturulmuştur. '
      + 'Bu bir özettir; fatura veya ödeme talebi değildir.',
  },
  reminder: {
    intro: 'Bu e-posta, {label} ({range}) hesap dökümü için haftalık hatırlatmadır.',
    handIn: 'Bu haftaya ait henüz yüklemediğiniz fişleriniz varsa lütfen şimdi yükleyin.',
    // "saat {clock} olduğunda" and not "{clock}'da": a suffix after a time changes
    // with the time's last digit, and the sentence is filled with any time.
    when: 'Bu haftanın hesap dökümü, saat {clock} olduğunda {company} tarafından otomatik olarak e-postayla gönderilir. '
      + 'Bundan sonra yüklenen fişler rakamlara dahil edilmez.',
    ignore: 'Bu haftaya ait tüm fişlerinizi zaten yüklediyseniz bu e-postayı dikkate almanıza gerek yoktur.',
    clock: '{time}',
    subject: 'Hesap dökümü hatırlatması: {label} – {company}',
    heading: 'Hesap dökümü hatırlatması',
    preheader: '{range} hesap dökümü saat {clock} olduğunda gönderilecek',
    note: 'Bu e-posta, şirketinizin muhasebe sistemi tarafından otomatik olarak oluşturulmuştur. '
      + 'Bu bir hatırlatmadır; fatura veya ödeme talebi değildir.',
  },
};

const RU: DriverMailCopy = {
  hello: 'Здравствуйте, {name}!',
  helloPlain: 'Здравствуйте!',
  footer: [
    'El-Professor · Управление зарплатой и планированием для компаний такси и аренды автомобилей с водителем',
    'Это письмо отправлено автоматически. Ответы на этот адрес не читаются.',
  ],
  abrechnung: {
    // A colon before {label} and not "за {label}": the label is a nominative
    // ("Неделя 5 - Август 2026"), and "за" would ask for another case.
    intro: 'Ваш расчёт: {label} ({range}).',
    cash: 'Получено наличными',
    belege: 'Чеки ({count})',
    // Not "К сдаче": on a till receipt that is the change handed back to a customer.
    owes: 'Нужно сдать',
    credit: 'К получению',
    tankenquote: 'Доля расходов на топливо',
    imageNote: 'Сводка также приложена к этому письму в виде изображения.',
    sources: 'Данные взяты из записей компании {company}. Если у вас есть вопросы, обратитесь в офис.',
    subject: 'Расчёт: {label} – {company}',
    heading: 'Расчёт: {label}',
    preheader: 'Ваш расчёт за период {range}',
    note: 'Это письмо автоматически создано системой расчётов вашей компании. '
      + 'Это сводка, а не счёт и не требование об оплате.',
  },
  reminder: {
    intro: 'Это еженедельное напоминание о расчёте: {label} ({range}).',
    handIn: 'Если у вас ещё есть чеки за эту неделю, пожалуйста, загрузите их сейчас.',
    when: 'В {clock} компания {company} автоматически отправит расчёт за эту неделю по электронной почте. '
      + 'Чеки, загруженные позже, не будут учтены в расчёте.',
    ignore: 'Если вы уже загрузили все чеки за эту неделю, можете просто проигнорировать это письмо.',
    clock: '{time}',
    subject: 'Напоминание о расчёте: {label} – {company}',
    heading: 'Напоминание о расчёте',
    preheader: 'Расчёт за период {range} будет отправлен в {clock}',
    note: 'Это письмо автоматически создано системой расчётов вашей компании. '
      + 'Это напоминание, а не счёт и не требование об оплате.',
  },
};

export const DRIVER_MAIL_COPY: Record<MailLanguage, DriverMailCopy> = { de: DE, en: EN, ar: AR, tr: TR, ru: RU };

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

const MONTHS: Record<Exclude<MailLanguage, 'de'>, Record<string, string>> = {
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
  tr: {
    Januar: 'Ocak', Februar: 'Şubat', 'März': 'Mart', April: 'Nisan', Mai: 'Mayıs', Juni: 'Haziran',
    Juli: 'Temmuz', August: 'Ağustos', September: 'Eylül', Oktober: 'Ekim',
    November: 'Kasım', Dezember: 'Aralık',
  },
  ru: {
    Januar: 'Январь', Februar: 'Февраль', 'März': 'Март', April: 'Апрель', Mai: 'Май', Juni: 'Июнь',
    Juli: 'Июль', August: 'Август', September: 'Сентябрь', Oktober: 'Октябрь',
    November: 'Ноябрь', Dezember: 'Декабрь',
  },
};

const WEEK_WORD: Record<Exclude<MailLanguage, 'de'>, string> = {
  en: 'Week', ar: 'الأسبوع', tr: 'Hafta', ru: 'Неделя',
};

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
