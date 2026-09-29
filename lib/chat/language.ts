// Per-message language for the `lang` attribute alongside `dir="auto"`, so
// screen readers pronounce mixed Arabic/English transcripts correctly.
//
// Deliberately a script-range check only: the two languages in this product's
// transcripts are Arabic and English, and a model call for language detection
// would be absurd overhead on every message. If more languages ever need
// distinct pronunciation, this is the seam to extend.

/** Arabic script: base block, supplement, extended-A, presentation forms. */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/** 'ar' when any Arabic-script character is present, 'en' otherwise. */
export function detectLang(text: string | null | undefined): 'ar' | 'en' {
  if (!text) return 'en';
  return ARABIC_SCRIPT.test(text) ? 'ar' : 'en';
}
