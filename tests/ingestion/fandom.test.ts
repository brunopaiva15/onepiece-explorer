import { describe, expect, it } from 'vitest'
import {
  chapterNumberFrom,
  citableAndParallel,
  decodeEntities,
  fetchChapterSummaries,
  htmlToParagraphs,
  type Fetcher,
} from '@/domains/ingestion/fandom.ts'

/**
 * Fetching a chapter instead of typing it.
 *
 * Three properties, and the first is a security one. The field accepts a URL,
 * and nothing in that URL is ever requested: it is read for a chapter number and
 * discarded, and the two endpoints are constants. "No network call built from a
 * URL found in input" is a criterion of this project, and this is the one
 * feature that could quietly break it.
 *
 * The second is that a missing language is an outcome, not a failure — the
 * French wiki is hundreds of chapters behind the English one, and a chapter that
 * exists in one language must still import.
 *
 * The third is that what comes back is prose. Passages are the citable unit, so
 * a navigation table flattened into text would become a passage of chapter
 * numbers that a fact could be anchored to, which is evidence proving nothing.
 */

/** A fetcher that answers from a table and records what was asked. */
function stub(routes: Record<string, unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (url: string) => {
    calls.push(url)
    const key = Object.keys(routes).find((route) => url.includes(route))
    if (key === undefined) {
      return { ok: true, status: 200, json: async () => ({ error: { info: 'Page inexistante.' } }) }
    }
    return { ok: true, status: 200, json: async () => routes[key] }
  }) as Fetcher & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

const sections = (line: string) => ({ parse: { sections: [{ index: '2', line }] } })
const manySections = (...lines: Array<[index: string, line: string]>) => ({
  parse: { sections: lines.map(([index, line]) => ({ index, line })) },
})
const body = (html: string) => ({ parse: { text: { '*': html } } })

describe('reading a chapter number', () => {
  it('takes it from either wiki’s URL, or from the number alone', () => {
    expect(chapterNumberFrom('https://onepiece.fandom.com/wiki/Chapter_1')).toBe(1)
    expect(chapterNumberFrom('https://onepiece.fandom.com/fr/wiki/Chapitre_1042')).toBe(1042)
    expect(chapterNumberFrom('  1042 ')).toBe(1042)
    // Percent-encoded, as a browser hands it over.
    expect(chapterNumberFrom('https://onepiece.fandom.com/fr/wiki/Chapitre%5F7')).toBe(7)
  })

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => chapterNumberFrom('https://example.com/whatever')).toThrow(/numéro de chapitre/)
  })
})

describe('what actually gets requested', () => {
  it('never requests the address it was given', async () => {
    const fetcher = stub({
      'fandom.com/fr/api.php': sections('Résumé approfondi'),
      'fandom.com/api.php': sections('Long Summary'),
    })

    // A hostile address, carrying a perfectly readable chapter number.
    const chapter = chapterNumberFrom('https://attacker.example/wiki/Chapter_9?x=1')
    await fetchChapterSummaries(chapter, fetcher).catch(() => null)

    expect(fetcher.calls.length).toBeGreaterThan(0)
    for (const call of fetcher.calls) {
      expect(call.startsWith('https://onepiece.fandom.com/')).toBe(true)
      expect(call).not.toContain('attacker.example')
    }
  })
})

describe('fetching both languages', () => {
  const french = '<p>Luffy supplie Shanks de l’emmener en mer.</p><p>Shanks refuse.</p>'
  const english = '<p>Luffy begs Shanks to take him to sea.</p>'

  it('returns the French as well as the English summary', async () => {
    const fetcher = stub({
      'fr/api.php?action=parse&page=Chapitre+1&prop=sections': sections('Résumé approfondi'),
      'fr/api.php?action=parse&page=Chapitre+1&section=2': body(french),
      'com/api.php?action=parse&page=Chapter+1&prop=sections': sections('Long Summary'),
      'com/api.php?action=parse&page=Chapter+1&section=2': body(english),
    })

    const result = await fetchChapterSummaries(1, fetcher)

    expect(result.problems).toEqual([])
    expect(result.summaries.map((summary) => summary.language)).toEqual(['fr', 'en'])
    expect(result.summaries[0]!.text).toContain('Luffy supplie Shanks')
    expect(result.summaries[0]!.url).toContain('/fr/wiki/Chapitre_1')
  })

  it('brings back the one it has, and says why the other is missing', async () => {
    // The ordinary case on recent chapters: English written up, French not yet.
    const fetcher = stub({
      'com/api.php?action=parse&page=Chapter+1&prop=sections': sections('Long Summary'),
      'com/api.php?action=parse&page=Chapter+1&section=2': body(english),
    })

    const result = await fetchChapterSummaries(1, fetcher)

    expect(result.summaries.map((summary) => summary.language)).toEqual(['en'])
    expect(result.problems[0]?.language).toBe('fr')
    expect(result.problems[0]?.reason).toContain('inexistante')
  })

  it('fails loudly when neither language has the chapter', async () => {
    await expect(fetchChapterSummaries(9999, stub({}))).rejects.toThrow(/Aucun résumé/)
  })

  it('reports a renamed section instead of picking another one', async () => {
    const fetcher = stub({
      'com/api.php?action=parse&page=Chapter+1&prop=sections': sections('Short Summary'),
    })

    const result = await fetchChapterSummaries(1, fetcher).catch((error: Error) => error)
    expect(String(result)).toContain('introuvable')
  })
})

describe('the chapter notes', () => {
  /**
   * « Quick Reference → Chapter Notes », « Informations → Notes ».
   *
   * The bullets the retelling dilutes: « Arlong kills Bell-mère » is one line of
   * chapter 78's notes and no sentence of its Long Summary says it that plainly.
   * They are appended to the citable text rather than stored beside it, because
   * the graph can only ever hold what its citable text states — notes kept
   * anywhere else would be facts the reviewer can read and the pipeline cannot
   * propose.
   */
  const englishPage = manySections(['3', 'Long Summary'], ['5', 'Chapter Notes'])

  it('appends them to the citable text, after the retelling', async () => {
    const fetcher = stub({
      'com/api.php?action=parse&page=Chapter+78&prop=sections': englishPage,
      'page=Chapter+78&section=3': body('<p>Arlong points his rifle at her.</p>'),
      'page=Chapter+78&section=5': body(
        '<ul><li>Nami’s flashback continues.<ul><li>Arlong kills Bell-mère.</li></ul></li></ul>',
      ),
    })

    const result = await fetchChapterSummaries(78, fetcher)
    const english = result.summaries.find((summary) => summary.language === 'en')!

    expect(english.text).toBe(
      'Arlong points his rifle at her.\n\n' +
        'Nami’s flashback continues.\n\n' +
        'Arlong kills Bell-mère.',
    )
    expect(english.notes).toContain('Arlong kills Bell-mère.')
    expect(english.notesSection).toBe('Chapter Notes')
  })

  it('reads « Informations → Notes » on the French wiki', async () => {
    const fetcher = stub({
      'fr/api.php?action=parse&page=Chapitre+42&prop=sections': manySections(
        ['4', 'Résumé approfondi'],
        ['6', 'Notes'],
      ),
      'page=Chapitre+42&section=4': body('<p>Luffy hisse le pavillon.</p>'),
      'page=Chapitre+42&section=6': body(
        '<ul><li>Johnny et Yosaku font leur première apparition.</li></ul>',
      ),
    })

    const result = await fetchChapterSummaries(42, fetcher)
    const french = result.summaries.find((summary) => summary.language === 'fr')!

    expect(french.notesSection).toBe('Notes')
    expect(french.text).toContain('première apparition')
  })

  it('leaves a page without notes exactly as it was, and asks nothing extra', async () => {
    const fetcher = stub({
      'com/api.php?action=parse&page=Chapter+1&prop=sections': sections('Long Summary'),
      'page=Chapter+1&section=2': body('<p>Shanks refuses.</p>'),
    })

    const result = await fetchChapterSummaries(1, fetcher)
    const english = result.summaries.find((summary) => summary.language === 'en')!

    expect(english.text).toBe('Shanks refuses.')
    expect(english.notes).toBe('')
    expect(english.notesSection).toBeNull()
    // Two requests for this language and no third: a page with no notes costs
    // nothing, because the heading list was already in hand.
    const english_calls = fetcher.calls.filter((call) => !call.includes('/fr/'))
    expect(english_calls).toHaveLength(2)
  })

  it('refuses a heading that merely contains the word', async () => {
    // « Notes et références » is a bibliography. Stored as chapter notes it
    // would be a passage of citations that a fact could be anchored to.
    const fetcher = stub({
      'fr/api.php?action=parse&page=Chapitre+7&prop=sections': manySections(
        ['4', 'Résumé approfondi'],
        ['9', 'Notes et références'],
      ),
      'page=Chapitre+7&section=4': body('<p>Zoro accepte de le suivre.</p>'),
      'page=Chapitre+7&section=9': body('<ul><li>Oda, SBS volume 4.</li></ul>'),
    })

    const result = await fetchChapterSummaries(7, fetcher)
    const french = result.summaries.find((summary) => summary.language === 'fr')!

    expect(french.notesSection).toBeNull()
    expect(french.text).toBe('Zoro accepte de le suivre.')
  })

  it('keeps the summary when the notes themselves fail', async () => {
    // The section is listed and its body does not come back. A summary lost
    // over an optional section would be a bad trade.
    const fetcher = stub({
      'com/api.php?action=parse&page=Chapter+9&prop=sections': manySections(
        ['3', 'Long Summary'],
        ['5', 'Chapter Notes'],
      ),
      'page=Chapter+9&section=3': body('<p>Buggy fires the cannon.</p>'),
    })

    const result = await fetchChapterSummaries(9, fetcher)
    const english = result.summaries.find((summary) => summary.language === 'en')!

    expect(english.text).toBe('Buggy fires the cannon.')
    expect(english.notes).toBe('')
  })
})

describe('which text becomes the source', () => {
  /**
   * English is citable and French only names things, which is the opposite of
   * what a French-language graph suggests. The English "Long Summary" is the
   * detailed one, and a graph can only contain what its citable text states; the
   * French page's value is the convention it carries — how a French reader
   * renders a name — which is exactly what the model cannot derive from English.
   */
  const summary = (language: 'fr' | 'en', text: string) => ({
    language,
    page: language === 'fr' ? 'Chapitre 1' : 'Chapter 1',
    url: 'https://onepiece.fandom.com/',
    section: language === 'fr' ? 'Résumé approfondi' : 'Long Summary',
    text,
    notes: '',
    notesSection: null,
  })

  it('cites the English and names from the French', () => {
    const { citable, naming } = citableAndParallel({
      chapterNumber: 1,
      summaries: [summary('fr', 'Version française.'), summary('en', 'English version.')],
      problems: [],
    })

    expect(citable.language).toBe('en')
    expect(naming?.language).toBe('fr')
  })

  it('uses the only language there is, with no naming aid', () => {
    const { citable, naming } = citableAndParallel({
      chapterNumber: 1,
      summaries: [summary('fr', 'Version française.')],
      problems: [],
    })

    expect(citable.language).toBe('fr')
    expect(naming).toBeNull()
  })
})

describe('turning wiki markup into passages', () => {
  it('keeps the paragraphs and drops the furniture', () => {
    const html = [
      '<div class="mw-parser-output">',
      '<h2>Long Summary<span class="mw-editsection">[edit]</span></h2>',
      '<p>Shanks refuses to take the boy to sea<sup class="reference">[1]</sup>.</p>',
      '<table class="navbox"><tr><td>Chapter 1</td><td>Chapter 2</td></tr></table>',
      '<p>Later, the boy swallows a strange fruit.</p>',
      '</div>',
    ].join('')

    expect(htmlToParagraphs(html)).toBe(
      'Shanks refuses to take the boy to sea.\n\n' +
        'Later, the boy swallows a strange fruit.',
    )
  })

  it('unwraps links without losing their text', () => {
    expect(htmlToParagraphs('<p>Il rencontre <a href="/wiki/Shanks">Shanks</a>.</p>')).toBe(
      'Il rencontre Shanks.',
    )
  })

  it('decodes the entities the renderer escapes', () => {
    expect(decodeEntities('Fruit&nbsp;du D&eacute;mon &amp; co &#8212; &#x201C;oui&#x201D;')).toBe(
      'Fruit du D&eacute;mon & co — “oui”',
    )
  })

  it('cuts a nested list where the eye cuts it', () => {
    // The shape of every Chapter Notes section: a bullet, and under it the
    // things it covers. The outer <li> closes after its children, so a block
    // that ended at its own </li> would swallow the first child and leave the
    // others standing alone.
    const html =
      '<ul><li>Nami’s flashback continues.' +
      '<ul><li>Arlong declares a tribute.</li>' +
      '<li>Arlong kills Bell-mère.</li></ul></li></ul>'

    expect(htmlToParagraphs(html)).toBe(
      'Nami’s flashback continues.\n\n' +
        'Arlong declares a tribute.\n\n' +
        'Arlong kills Bell-mère.',
    )
  })

  it('returns nothing rather than a passage of table cells', () => {
    expect(htmlToParagraphs('<table><tr><td>1</td></tr></table>')).toBe('')
  })
})
