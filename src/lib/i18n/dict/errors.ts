import type { Locale } from '../index.ts'

/**
 * The error boundary and the API routes' error strings. French defines the
 * shape; `typeof fr` makes English cover every key.
 *
 * The boundary's paragraphs are split where the JSX interleaves emphasis and
 * links; the segments concatenate (with the JSX's own spaces) back into the
 * original sentences.
 */
const fr = {
  // Error boundary (src/app/error.tsx).
  pageTitle: "Cette page n'a pas pu être rendue",
  noMessage:
    "Le message exact n'arrive pas jusqu'ici : en production il est remplacé " +
    "par une référence avant d'atteindre le navigateur, et c'est voulu — une " +
    'erreur peut contenir une chaîne de connexion. Cette page ne sait donc pas ' +
    'ce qui a échoué, et ne va pas le deviner.',
  allPagesFailLead: 'Si toutes les pages échouent',
  allPagesFailBody: ": c'est la configuration ou le schéma de la base.",
  statusPageLinkLabel: "L'état du déploiement",
  allPagesFailTail:
    "ne dépend de rien de ce qu'il contrôle, donc il répond même maintenant " +
    'et nomme ce qui manque.',
  onlyActionFailLead: 'Si seule cette action échoue',
  onlyActionFailBody:
    ': la cause est dans cette action, pas dans la configuration. Sur un ' +
    "envoi de fichier, le suspect habituel est la taille — le corps d'une " +
    "requête est plafonné par l'hébergeur, et Next.js ne transmet pas de " +
    'message quand la limite est franchie.',
  statusPageButton: 'État du déploiement',
  digestLead: 'Référence :',
  digestTail:
    "— à chercher dans les journaux d'exécution de l'hébergeur, où le " +
    'message complet est conservé.',

  // API routes.
  invalidKey: 'Clé invalide',
  notFound: 'Introuvable',
  linkExpired: 'Lien expiré ou invalide',
  exportRateLimited: (minutes: number) =>
    `Limite atteinte. Réessayez dans ${minutes} minute(s).`,
  streamTimeout: 'Flux interrompu après dix minutes.',
  streamReadFailed: 'Lecture impossible.',
}

const en: typeof fr = {
  pageTitle: 'This page could not be rendered',
  noMessage:
    'The exact message does not make it this far: in production it is ' +
    'replaced by a reference before reaching the browser, and that is ' +
    'deliberate — an error can contain a connection string. This page ' +
    'therefore does not know what failed, and will not guess.',
  allPagesFailLead: 'If every page fails',
  allPagesFailBody: ': it is the configuration or the database schema.',
  statusPageLinkLabel: 'The deployment status',
  allPagesFailTail:
    'depends on nothing it checks, so it answers even now and names what is missing.',
  onlyActionFailLead: 'If only this action fails',
  onlyActionFailBody:
    ': the cause is in this action, not in the configuration. On a file ' +
    'upload, the usual suspect is size — the request body is capped by the ' +
    'host, and Next.js passes no message along when the limit is exceeded.',
  statusPageButton: 'Deployment status',
  digestLead: 'Reference:',
  digestTail:
    "— look it up in the host's runtime logs, where the full message is kept.",

  invalidKey: 'Invalid key',
  notFound: 'Not found',
  linkExpired: 'Link expired or invalid',
  exportRateLimited: (minutes: number) =>
    `Limit reached. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  streamTimeout: 'Stream stopped after ten minutes.',
  streamReadFailed: 'Read failed.',
}

export const errors = { fr, en } satisfies Record<Locale, typeof fr>
