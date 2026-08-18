/**
 * La discipline commune à toutes les lectures payantes de cette page.
 *
 * Quatre analyses posent quatre questions différentes, et se font mentir de la
 * même façon : un modèle à qui l'on tend quarante lignes en citera parfois une
 * quarante-et-unième, au bon format, avec un numéro de chapitre plausible. Le
 * balayage des identités l'a écrit une fois, celui des mystères une deuxième,
 * la relecture des chapitres une troisième — et une quatrième copie serait une
 * quatrième occasion d'oublier la moitié qui compte.
 *
 * Trois règles, et elles sont toutes des refus :
 *
 *   **Un identifiant se recopie, il ne se forme pas.** Ce qui n'est pas dans la
 *   liste fournie n'existe pas, quelle que soit sa vraisemblance.
 *
 *   **Une citation est dans le texte, mot pour mot.** Comparée sur la forme
 *   normalisée — accents, apostrophes et ponctuation repliés — parce qu'un
 *   modèle recopie en corrigeant la typographie, et refuser « Bell-mere » parce
 *   que la source écrit « Bell-mère » serait refuser une citation honnête.
 *
 *   **Le chapitre vient du graphe, jamais de la réponse.** Le modèle cite une
 *   scène ou un passage ; le code lit son chapitre. Une date choisie par le
 *   modèle est une révélation posée à la mauvaise frontière, c'est-à-dire un
 *   spoiler avec une note de bas de page.
 *
 * Ni `server-only`, ni base, ni fournisseur : ce qui est jugé ici est du texte,
 * et une règle qu'on ne peut exercer qu'au prix d'un appel facturé est une
 * règle que personne n'exerce.
 */
import { normalizeText } from '@/domains/knowledge/normalize.ts'

/**
 * Une réponse de modèle, dépouillée de son transport.
 *
 * Les appelants reçoivent un `ProviderResult<Answer>` ; ce qu'ils passent ici
 * est ce qu'il en reste une fois le refus, l'usage et la forme du fournisseur
 * mis de côté. C'est ce qui permet à un test d'exercer un verdict complet sans
 * fabriquer un fournisseur.
 */
export interface ModelReply {
  /** Vrai quand le modèle a décliné : `value` n'est alors pas lisible. */
  refusal: boolean
  text: string
  citations: Array<{ id: string; excerpt: string }>
}

/**
 * Les lignes d'une réponse tabulaire, nettoyées.
 *
 * Le format est plat, une ligne par constat, les champs séparés par une barre
 * verticale — celui de la relecture, pour la raison qui l'a fait choisir là-bas
 * : il n'y a pas de méthode « juger » sur le fournisseur, et lui en ajouter une
 * voudrait dire l'écrire cinq fois pour gagner des accolades.
 *
 * Le dernier champ absorbe tout ce qui suit son séparateur : une phrase citée a
 * le droit de contenir une barre verticale, et en perdre la fin ferait échouer
 * l'ancrage d'une citation par ailleurs honnête.
 */
export function verdictLines(text: string, fields: number): string[][] {
  const rows: string[][] = []

  for (const line of text.split('\n')) {
    const parts = line.split('|').map((field) => field.trim())
    if (parts.length < fields) continue

    const head = parts.slice(0, fields - 1)
    head[0] = (head[0] ?? '').replace(/^[-•*\s]+/, '')
    if (head.some((field) => field.length === 0)) continue

    rows.push([...head, parts.slice(fields - 1).join(' | ').trim()])
  }

  return rows
}

/** Le passage qui porte vraiment cette citation, ou rien. */
export function quotedFrom<T extends { text: string }>(
  excerpt: string,
  passages: readonly T[],
): T | null {
  const needle = normalizeText(excerpt.trim())
  if (needle.length === 0) return null
  return passages.find((passage) => normalizeText(passage.text).includes(needle)) ?? null
}

/** La citation est-elle dans l'un de ces textes ? */
export function anchoredIn(excerpt: string, passages: readonly string[]): boolean {
  return quotedFrom(excerpt, passages.map((text) => ({ text }))) !== null
}

/**
 * Ce que le modèle a le droit de citer, indexé.
 *
 * Une `Map` plutôt qu'un `Set` parce que tous les appelants ont besoin de la
 * ligne et pas seulement de sa permission : le chapitre d'une scène, le texte
 * d'un passage, le type d'une entité. Le refus et la lecture sont ainsi la même
 * opération, et il devient impossible d'accepter un identifiant sans lire ce
 * qu'il désigne.
 */
export function allowed<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map((row) => [key(row), row]))
}

/**
 * Une réponse qui décline, sous toutes ses formes.
 *
 * `insufficient_data` est la réponse attendue et la plus fréquente : les
 * consignes le disent, et un modèle qui l'écrit en prose plutôt qu'en champ ne
 * doit pas voir sa retenue lue comme un constat. Ce qui compte est qu'aucune
 * ligne bien formée n'en sorte, et c'est vrai des deux côtés — une réponse
 * vide n'a rien à dire non plus.
 */
export function declines(reply: ModelReply): boolean {
  if (reply.refusal) return true
  const text = reply.text.trim().toLowerCase()
  return text.length === 0 || text === 'insufficient_data'
}
