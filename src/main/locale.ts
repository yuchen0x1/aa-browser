import { app } from 'electron'
import { resolveLocale, type Locale } from '../shared/locale'
import { getSettingsStore } from './settings'

/** Resolve once per operation so all diagnostics in that operation use one locale. */
export function getMainLocale(): Locale {
  return resolveLocale(getSettingsStore().get().locale, [app.getLocale()])
}
