export const LANGUAGES = ['auto', 'en', 'gu', 'hi'] as const

export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: Language
  label: string
  locale: string
  speechCode?: string
}> = [
  {
    value: 'auto',
    label: 'Auto-detect',
    locale: 'en-GB',
  },
  {
    value: 'en',
    label: 'English',
    locale: 'en-GB',
    speechCode: 'eng',
  },
  {
    value: 'gu',
    label: 'ગુજરાતી',
    locale: 'gu-IN',
    speechCode: 'guj',
  },
  {
    value: 'hi',
    label: 'हिन्दी',
    locale: 'hi-IN',
    speechCode: 'hin',
  },
]

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language)
}

export function languageOption(language: Language) {
  return LANGUAGE_OPTIONS.find((option) => option.value === language)!
}

export function preferredLanguage(): Language {
  try {
    const value = localStorage.getItem('jarvis.inputLanguage')
    if (isLanguage(value)) return value
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
  return 'auto'
}

export function savePreferredLanguage(language: Language): void {
  try {
    localStorage.setItem('jarvis.inputLanguage', language)
  } catch {
    // Keep the in-memory selection usable when storage is unavailable.
  }
}
