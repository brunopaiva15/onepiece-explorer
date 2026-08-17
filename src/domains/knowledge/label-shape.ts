/**
 * Whether a label names a thing, or tells the story of the scene it came from.
 *
 * « Escargophone utilisé par Crocodile pour contacter les Billions » is a real
 * proposal, honestly derived from the page, anchored to an excerpt that says
 * exactly that — and it is not a name. Nothing downstream could tell: evidence
 * anchoring checks the *claim*, the ontology checks the *type*, and a label is
 * free text that both of them wave through. So the sentence becomes the name of
 * an object, on its fiche, in the search index, and in every chapter after.
 *
 * Two things break, and the second is the expensive one:
 *
 *   It is unreadable. A graph whose nodes are sentences reads as a summary of
 *   the chapter it was extracted from rather than as a cast.
 *
 *   It is true only here. The circumstances are in the name, so the same
 *   Escargophone three chapters later, in another hand, gets another
 *   description — and the graph keeps two objects where the story has one. That
 *   is the same failure `naming_confident` exists to prevent, arriving through
 *   a door nobody was watching: both labels are anchored, both are honest, and
 *   no exact-twin check or trigram matcher will ever join them.
 *
 * What makes this checkable without a model is that the difference is
 * grammatical rather than editorial. A name is a noun phrase. A description
 * hangs a clause off it — an agent (« provoquées PAR Crocodile »), a purpose
 * (« POUR contacter les Billions »), a relative (« QUI garde la prison ») — and
 * that clause is precisely the part that belongs in a relation instead.
 *
 * So this looks for the clause, not for the meaning, and it never rewrites
 * anything on its own: a label it flags goes to a human with the noun phrase it
 * found offered as a suggestion. Cutting silently would be worse than the
 * verbosity — « Tempêtes de sable de Yuba » is right and « Escargophone » loses
 * whose it is, and only a reader can tell which of the two just happened.
 */

/** What was found, and the name inside it if the cut leaves one. */
export interface DescriptiveLabel {
  /** `clause` when a clause hangs off it; `length` when it is simply long. */
  reason: 'clause' | 'length'
  /** The noun phrase before the clause, when it stands on its own. */
  suggestion: string | null
}

/**
 * Above this, a label is a phrase whatever its grammar.
 *
 * Six words holds every naming convention this work actually uses —
 * « Équipage du Chapeau de Paille » is five, « l'homme au foulard rayé » is
 * four, « Village de Fuchsia » is three — and the labels that prompted this were
 * eight and nine. It is a ceiling, not a target: nothing shortens a label for
 * being at five.
 */
const MAX_WORDS = 6

/**
 * The words that start a clause, and therefore end a name.
 *
 * Function words only, so the test is about grammar rather than vocabulary. A
 * verb list would have to guess at the conjugations of a language it does not
 * read, and would flag « Le Chirurgien de la Mort » for the noun in it.
 *
 * `par` is absent on purpose and handled below: it is a preposition in
 * « Tempêtes de sable » constructions as often as it is an agent marker, and
 * what makes it one is the past participle in front of it.
 */
const CLAUSE_WORDS = new Set([
  'qui',
  'que',
  "qu'",
  'dont',
  'où',
  'pour',
  'afin',
  'lorsque',
  "lorsqu'",
  'quand',
  'parce',
  'tandis',
  'pendant',
  'depuis',
  'après',
  'avant',
])

/**
 * A past participle, by ending. What turns « par » into an agent.
 *
 * Deliberately used in one place only. The endings it matches are the endings
 * of half the vocabulary — « Bananawani » ends in `i` and « Vivi » in `i` — so
 * it is meaningless on its own and precise in the one position where it is
 * asked a question with a grammatical answer: the word sitting immediately
 * before « par ».
 */
const PARTICIPLE = /(?:é|ée|és|ées|i|ie|is|ies|u|ue|us|ues|ant)$/i

/**
 * Words that are not a name on their own, so a clause behind one is the name.
 *
 * « Ceux qui restent » is a group and its whole name is those three words;
 * cutting it at the pronoun would leave « Ceux », which names nothing. Same for
 * a bare article. Anything else in front of a pronoun is a noun, and a noun
 * followed by a relative clause is exactly the shape this looks for.
 */
const NOT_A_NAME = new Set([
  'ceux',
  'celui',
  'celle',
  'celles',
  'ce',
  'cet',
  'cette',
  'ces',
  'le',
  'la',
  'les',
  "l'",
  'un',
  'une',
  'des',
  'du',
  'de',
])

/**
 * Words a name does not end on, stripped from a suggestion.
 *
 * Cutting « Escargophone utilisé par Crocodile » before its agent leaves
 * « Escargophone utilisé », and « Le Bar de » is what cutting on a purpose
 * clause can leave. Neither is a name, and offering one as the repair would
 * teach the reviewer to ignore the offer.
 */
const TRAILING = new Set([
  'de',
  'du',
  'des',
  "d'",
  'à',
  'au',
  'aux',
  'en',
  'le',
  'la',
  'les',
  "l'",
  'et',
  'ou',
  'avec',
  'dans',
  'sur',
  'sous',
  'par',
  'pour',
  'chez',
  'vers',
  'contre',
  'sans',
])

/**
 * Punctuation that only appears in a label because a sentence got in.
 *
 * The full stop is absent, and « Monkey D. Luffy » is why: an initial is a full
 * stop in the middle of a name, and reading it as the end of a sentence would
 * flag the best-named character in the work and offer « Monkey D » as the
 * repair. A comma, a semicolon or a colon has no business in a name at all.
 */
const SENTENCE_MARK = /[,;:]/

const words = (value: string): string[] => value.split(/\s+/).filter((word) => word.length > 0)

/** A word as it is compared: lowercased, stripped of the punctuation glued to it. */
const bare = (word: string): string => word.toLowerCase().replace(/^[«"(]+|[»",;:.!?)]+$/g, '')

/**
 * The label with its clause removed, or null when nothing usable is left.
 *
 * A suggestion is offered as a button the reviewer presses without re-reading,
 * so what it leaves has to be a name on its own. The cut therefore walks
 * backwards over the words a name never ends on — « Escargophone utilisé »,
 * « Le Bar de » — and gives up entirely rather than offer the two letters that
 * can remain.
 */
function cutBefore(source: string[], index: number, agent: boolean): string | null {
  let end = index

  // The participle that introduced the agent goes with it: « Escargophone
  // utilisé | par Crocodile » is not a name until `utilisé` leaves too. Only
  // there: « L'homme au foulard rayé | qui menace le village » keeps its
  // participle, which is the very thing the name is built on.
  if (agent && end > 0 && PARTICIPLE.test(bare(source[end - 1]!))) end--

  while (end > 0 && TRAILING.has(bare(source[end - 1]!))) end--

  const kept = source.slice(0, end)
  if (kept.length === 0) return null

  const suggestion = kept.join(' ').replace(SENTENCE_MARK, '').trim()
  return suggestion.length >= 3 ? suggestion : null
}

/**
 * Read a label as a name, and say so when it cannot be read as one.
 *
 * Pure and shared on purpose: the pipeline calls it to decide that a proposal
 * must be seen by a human, and the review card calls it to say why it is being
 * asked. Two copies of this rule would mean a card explaining a decision the
 * pipeline did not take.
 */
export function readsAsDescription(label: string): DescriptiveLabel | null {
  const trimmed = label.trim()
  if (trimmed.length === 0) return null

  const parts = words(trimmed)

  for (let index = 0; index < parts.length; index++) {
    const word = bare(parts[index]!)

    const isAgent = word === 'par' && index > 0 && PARTICIPLE.test(bare(parts[index - 1]!))
    if (!isAgent && !CLAUSE_WORDS.has(word)) continue

    // A clause with nothing but an article in front of it is not a clause
    // hanging off a name: it is the name. « Ceux qui restent » is a group.
    if (index === 0) continue
    if (index === 1 && NOT_A_NAME.has(bare(parts[0]!))) continue

    return { reason: 'clause', suggestion: cutBefore(parts, index, isAgent) }
  }

  /*
   * A sentence gives itself away by its punctuation, and the cut is clean: what
   * precedes the comma is the thing, what follows it is what the thing does.
   */
  const marked = parts.findIndex((word) => SENTENCE_MARK.test(word))
  if (marked !== -1 && marked < parts.length - 1) {
    return { reason: 'clause', suggestion: cutBefore(parts, marked + 1, false) }
  }

  if (parts.length > MAX_WORDS) {
    // No clause to cut on, so nothing is offered: a label this long without one
    // is a compound name or a list, and truncating either invents a name.
    return { reason: 'length', suggestion: null }
  }

  return null
}

/** Whether a proposal's label must be read by a person before it is stored. */
export const labelNeedsReading = (label: string): boolean => readsAsDescription(label) !== null
