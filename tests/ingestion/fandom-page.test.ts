import { describe, expect, it } from 'vitest'
import {
  fetchChapterPages,
  htmlToParagraphs,
  type Fetcher,
} from '@/domains/ingestion/fandom.ts'

/**
 * La page entière, pour un lecteur qui n'est pas le graphe.
 *
 * `fetchChapterSummaries` prend deux sections et rien d'autre, parce que ce
 * qu'elle rend devient citable. Celle-ci prend tout, parce que ce qu'elle rend
 * sert à *trancher* des cartes et jamais à en écrire : l'arbitrage y cherche une
 * phrase, la liste des personnages, la graphie française d'un nom.
 *
 * Trois propriétés, et la première est la même que celle de sa voisine : aucune
 * requête n'est construite à partir d'une entrée. La deuxième est que les titres
 * de section survivent, faute de quoi quarante paragraphes de récit, de notes et
 * d'anecdotes arrivent en un seul mur. La troisième est qu'une langue manquante
 * est un résultat — le wiki français a des centaines de chapitres de retard.
 */

function stub(routes: Record<string, unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (url: string) => {
    calls.push(url)
    const key = Object.keys(routes).find((route) => url.includes(route))
    if (key === undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ error: { info: 'Page inexistante.' } }),
      }
    }
    return { ok: true, status: 200, json: async () => routes[key] }
  }) as Fetcher & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

const body = (html: string) => ({ parse: { text: { '*': html } } })

const FR = body(`
  <h2><span class="mw-headline">Résumé approfondi</span></h2>
  <p>Luffy quitte le Village de Fuchsia.</p>
  <table class="navbox"><tr><td>Chapitre 1</td><td>Chapitre 2</td></tr></table>
  <h2>Notes</h2>
  <ul><li>Première apparition de Shanks.</li></ul>
`)

const EN = body(`
  <h2>Long Summary</h2>
  <p>Luffy leaves Foosha Village.</p>
`)

describe('la page entière du chapitre', () => {
  it('rend les deux langues, titres de section compris', async () => {
    const fetched = await fetchChapterPages(
      1,
      stub({ 'fandom.com/fr/api.php': FR, 'fandom.com/api.php': EN }),
    )

    expect(fetched.pages.map((page) => page.language).sort()).toEqual(['en', 'fr'])

    const french = fetched.pages.find((page) => page.language === 'fr')!
    expect(french.text).toContain('## Résumé approfondi')
    expect(french.text).toContain('Luffy quitte le Village de Fuchsia.')
    expect(french.text).toContain('## Notes')
    expect(french.text).toContain('Première apparition de Shanks.')
    expect(french.url).toBe('https://onepiece.fandom.com/fr/wiki/Chapitre_1')
    expect(french.truncated).toBe(false)
  })

  it('laisse dehors les tableaux de navigation', async () => {
    const fetched = await fetchChapterPages(
      1,
      stub({ 'fandom.com/fr/api.php': FR, 'fandom.com/api.php': EN }),
    )

    const french = fetched.pages.find((page) => page.language === 'fr')!
    expect(french.text).not.toContain('Chapitre 2')
  })

  it('ne demande qu’une requête par langue', async () => {
    const fetcher = stub({ 'fandom.com/fr/api.php': FR, 'fandom.com/api.php': EN })
    await fetchChapterPages(1, fetcher)

    // La section n'est pas cherchée : c'est la page entière qui est demandée.
    expect(fetcher.calls).toHaveLength(2)
    for (const call of fetcher.calls) {
      expect(call.startsWith('https://onepiece.fandom.com/')).toBe(true)
      expect(call).toContain('prop=text')
      expect(call).not.toContain('section=')
    }
  })

  it('rapporte la langue manquante au lieu d’échouer', async () => {
    const fetched = await fetchChapterPages(1, stub({ 'fandom.com/api.php': EN }))

    expect(fetched.pages.map((page) => page.language)).toEqual(['en'])
    expect(fetched.problems.map((problem) => problem.language)).toEqual(['fr'])
  })

  it('rend une liste vide quand le wiki n’a le chapitre nulle part', async () => {
    const fetched = await fetchChapterPages(9999, stub({}))

    // Pas une exception : l'arbitrage sans page est une étape qui s'ignore en
    // disant pourquoi, et la file reste intacte derrière.
    expect(fetched.pages).toEqual([])
    expect(fetched.problems).toHaveLength(2)
  })
})

describe('les titres, quand on les demande', () => {
  it('les laisse dehors par défaut, pour que rien ne devienne un passage', () => {
    const text = htmlToParagraphs('<h2>Long Summary</h2><p>Luffy leaves.</p>')
    expect(text).toBe('Luffy leaves.')
  })

  it('les rend lisibles quand la page entière est lue', () => {
    const text = htmlToParagraphs('<h2>Long Summary</h2><p>Luffy leaves.</p>', {
      headings: true,
    })
    expect(text).toBe('## Long Summary\n\nLuffy leaves.')
  })
})
