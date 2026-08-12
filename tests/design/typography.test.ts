import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * The type is readable, and stays readable.
 *
 * This suite exists because the interface failed a reader before it failed a
 * test. Predicates were set in straw yellow on parchment — 1.4:1, a pale smear
 * where a word should be. Every label, badge, button and table header was set
 * in a condensed poster face at 11 to 14 pixels, which is a size that face was
 * never drawn for. Neither fault is visible in a diff, both are obvious on a
 * screen, and nothing in the suite would have objected to either.
 *
 * So the two rules that fixed it are asserted here rather than written down in
 * a comment nobody re-reads:
 *
 *   1. **A colour that sets text clears 4.5:1** against every surface of its
 *      own theme. Fills are exempt — a chip is read by its shape — which is
 *      why the palette carries `--x` for filling and `--x-ink` for writing.
 *   2. **The poster face stays above 18px.** Below that it goes to Nunito 800,
 *      via `.etiquette`.
 *
 * Both are checked against the stylesheet and the pages themselves, so the
 * failure lands on whoever reintroduces the problem instead of on a reader
 * six months later.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const CSS = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8')

/* --- WCAG 2.1 relative luminance and contrast ---------------------------- */

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/* --- Reading the tokens out of the stylesheet ---------------------------- */

/** Every `--name: value` inside the brace-balanced block opening at `selector`. */
function tokensIn(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector)
  expect(start, `selector ${selector} not found in globals.css`).toBeGreaterThan(-1)

  let depth = 0
  let end = start
  for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }

  const out: Record<string, string> = {}
  for (const [, name, value] of CSS.slice(start, end).matchAll(
    /(--[\w-]+)\s*:\s*([^;]+);/g,
  )) {
    out[name!] = value!.trim()
  }
  return out
}

// The first `:root` block is the light palette; the explicit `[data-theme]`
// block is dark. The `prefers-color-scheme` copy of dark is checked separately.
const LIGHT = tokensIn(':root {\n  color-scheme: light;')
const DARK = tokensIn(":root[data-theme='dark']")

/** The surfaces text can land on, in the order the stylesheet declares them. */
const SURFACES = ['--surface-base', '--surface-raised', '--surface-overlay', '--surface-sunken']

/** Colours that set type, and are therefore held to 4.5:1. */
const WRITING_TOKENS = [
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent-ink',
  '--sea-ink-text',
  '--lava-ink',
  '--epi-explicit-ink',
  '--epi-inferred-ink',
  '--epi-hypothetical-ink',
  '--epi-contradicted-ink',
  '--epi-refuted-ink',
  '--epi-validated-ink',
]

describe('couleurs de texte', () => {
  for (const [themeName, theme] of [
    ['clair', LIGHT],
    ['sombre', DARK],
  ] as const) {
    describe(themeName, () => {
      for (const token of WRITING_TOKENS) {
        it(`${token} est lisible sur toutes les surfaces`, () => {
          const colour = theme[token]
          expect(colour, `${token} manquant du thème ${themeName}`).toBeDefined()

          for (const surface of SURFACES) {
            const ratio = contrast(colour!, theme[surface]!)
            expect(
              Number(ratio.toFixed(2)),
              `${token} (${colour}) sur ${surface} (${theme[surface]})`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        })
      }
    })
  }

  it('les deux déclarations du thème sombre sont identiques', () => {
    // The palette is written twice — once under `prefers-color-scheme`, once
    // under `[data-theme='dark']`. A fix applied to one and not the other is
    // invisible until someone toggles the theme by hand.
    const media = tokensIn(":root:not([data-theme='light'])")
    for (const token of [...WRITING_TOKENS, ...SURFACES]) {
      expect(media[token], `${token} diverge entre les deux blocs sombres`).toBe(DARK[token])
    }
  })
})

describe('remplissages colorés portant du texte', () => {
  /*
   * A filled chip or button carries a word, and that word is the whole point of
   * the chip. `--sea` is the case that was wrong: bright enough that white on
   * it reaches 3.2:1, dark enough that black on it reaches 5.9:1, and the
   * palette note said so before anything used it.
   */
  const PAIRS = [
    ['--accent', '--ink'],
    ['--sea', '--ink'],
    ['--coral', '#FFFFFF'],
    ['--epi-validated', '#FFFFFF'],
    ['--sea-deep', '#FFFFFF'],
  ] as const

  for (const [fill, ink] of PAIRS) {
    it(`${fill} porte ${ink}`, () => {
      const background = LIGHT[fill]!
      const foreground = ink.startsWith('--') ? LIGHT[ink]! : ink
      expect(Number(contrast(foreground, background).toFixed(2))).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('chaque type de nœud a une encre lisible sur sa couleur', () => {
    // The chips that filter the graph. Fourteen colours, and no single ink
    // suits all of them — which is why each names its own.
    const types = tokensIn(':root {\n  --type-character:')
    const keys = Object.keys(types).filter((k) => !k.endsWith('-ink'))
    expect(keys.length).toBe(14)

    for (const key of keys) {
      const ink = types[`${key}-ink`]
      expect(ink, `${key} n’a pas d’encre déclarée`).toBeDefined()
      const resolved = ink === 'var(--ink)' ? LIGHT['--ink']! : ink!
      expect(
        Number(contrast(resolved, types[key]!).toFixed(2)),
        `${key} (${types[key]}) sous ${ink}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

/* --- The pages themselves ------------------------------------------------ */

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return pageFiles(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

const PAGES = pageFiles(path.join(ROOT, 'src/app')).map((file) => ({
  file: path.relative(ROOT, file),
  source: readFileSync(file, 'utf8'),
}))

describe('la fonte d’affichage reste une fonte d’affichage', () => {
  it('n’est jamais utilisée sous 18px', () => {
    // `text-base` and below. Anything from `text-lg` up may keep it.
    const tooSmall = /font-display[^"'`]*\btext-(?:xs|sm|base)\b|\btext-(?:xs|sm|base)\b[^"'`]*font-display/

    const offenders = PAGES.filter((p) => tooSmall.test(p.source)).map((p) => p.file)
    expect(offenders, 'utiliser .etiquette (Nunito 800) à ces tailles').toEqual([])
  })

  it('n’est pas réintroduite dans les composants du système', () => {
    for (const rule of ['.badge {', '.bouton {', '.cartouche {', 'thead th {']) {
      const block = CSS.slice(CSS.indexOf(rule), CSS.indexOf('}', CSS.indexOf(rule)))
      expect(block, `${rule} doit rester en --font-sans`).toContain('--font-sans')
    }
  })
})

describe('tailles de texte', () => {
  it('aucune taille arbitraire sous 13px', () => {
    // 0.8125rem is the floor, and it is `text-xs`. Anything hand-written below
    // it is the old habit coming back.
    const offenders: string[] = []
    for (const { file, source } of PAGES) {
      for (const [match, size] of source.matchAll(/text-\[(\d*\.?\d+)rem\]/g)) {
        if (Number(size) < 0.8125) offenders.push(`${file}: ${match}`)
      }
      for (const [match, size] of source.matchAll(/text-\[(\d+)px\]/g)) {
        if (Number(size) < 13) offenders.push(`${file}: ${match}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('le bas de l’échelle Tailwind est relevé', () => {
    const theme = tokensIn('@theme {')
    expect(theme['--text-xs']).toBe('0.8125rem')
    expect(theme['--text-sm']).toBe('0.9375rem')
  })
})
