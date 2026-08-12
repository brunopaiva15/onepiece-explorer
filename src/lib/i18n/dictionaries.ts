import type { Locale } from './index.ts'
import { ask } from './dict/ask.ts'
import { chapters } from './dict/chapters.ts'
import { common } from './dict/common.ts'
import { entity } from './dict/entity.ts'
import { errors } from './dict/errors.ts'
import { etat } from './dict/etat.ts'
import { home } from './dict/home.ts'
import { importer } from './dict/importer.ts'
import { review } from './dict/review.ts'
import { runs } from './dict/runs.ts'
import { search } from './dict/search.ts'
import { settings } from './dict/settings.ts'
import { shell } from './dict/shell.ts'
import { signin } from './dict/signin.ts'
import { timeline } from './dict/timeline.ts'

/**
 * One dictionary per language, assembled once at module load.
 *
 * Areas live in ./dict, one file per page group, each exporting `{ fr, en }`
 * with `typeof fr` forcing English to cover every key. Strings that carry a
 * value are functions, so pluralisation is written per language instead of
 * through a template mini-language.
 *
 * Not `server-only`: client components take a `locale` prop and call
 * `getDictFor` themselves — template functions cannot cross the RSC
 * serialisation boundary as props. Server code should prefer `getDict()` from
 * ./server.ts, which resolves the locale itself.
 */
function build(locale: Locale) {
  return {
    ask: ask[locale],
    chapters: chapters[locale],
    common: common[locale],
    entity: entity[locale],
    errors: errors[locale],
    etat: etat[locale],
    home: home[locale],
    importer: importer[locale],
    review: review[locale],
    runs: runs[locale],
    search: search[locale],
    settings: settings[locale],
    shell: shell[locale],
    signin: signin[locale],
    timeline: timeline[locale],
  }
}

export type Dict = ReturnType<typeof build>

const DICTS: Record<Locale, Dict> = { fr: build('fr'), en: build('en') }

export function getDictFor(locale: Locale): Dict {
  return DICTS[locale]
}
