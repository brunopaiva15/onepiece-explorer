import type { Locale } from '../index.ts'

/**
 * Vocabulary shared across pages, consolidated here so a concept is translated
 * once. Before this file, `epistemicLabel` existed three times with divergent
 * wording (entity page, graph table, review board) — the divergence is the
 * argument for the consolidation.
 */
const fr = {
  // Chapter status (status-badge, chapters list).
  status: {
    draft: 'brouillon',
    imported: 'importé',
    processing: 'en cours',
    review: 'à relire',
    published: 'publié',
    failed: 'échec',
  } as Record<string, string>,

  // Epistemic status of an assertion.
  epistemic: {
    explicit: 'explicite',
    inferred_strong: 'déduit',
    hypothetical: 'hypothèse',
  } as Record<string, string>,

  // Label kinds (entity_labels.kind).
  labelKind: {
    placeholder: 'libellé provisoire',
    alias: 'alias',
    true_name: 'vrai nom',
    epithet: 'épithète',
    translation: 'traduction',
  } as Record<string, string>,

  loading: 'Chargement…',
  retry: 'Réessayer',
  close: 'Fermer',
  cancel: 'Annuler',
  save: 'Enregistrer',
  none: 'aucun',
  unnamedEntity: 'entité sans nom révélé',
  unnamedEvent: 'événement sans nom',
  chapterN: (n: number) => `Chapitre ${n}`,
  authRequired: 'Authentification requise',
}

const en: typeof fr = {
  status: {
    draft: 'draft',
    imported: 'imported',
    processing: 'processing',
    review: 'to review',
    published: 'published',
    failed: 'failed',
  } as Record<string, string>,

  epistemic: {
    explicit: 'explicit',
    inferred_strong: 'inferred',
    hypothetical: 'hypothesis',
  } as Record<string, string>,

  labelKind: {
    placeholder: 'placeholder',
    alias: 'alias',
    true_name: 'true name',
    epithet: 'epithet',
    translation: 'translation',
  } as Record<string, string>,

  loading: 'Loading…',
  retry: 'Retry',
  close: 'Close',
  cancel: 'Cancel',
  save: 'Save',
  none: 'none',
  unnamedEntity: 'entity with no revealed name',
  unnamedEvent: 'unnamed event',
  chapterN: (n: number) => `Chapter ${n}`,
  authRequired: 'Authentication required',
}

export const common = { fr, en } satisfies Record<Locale, typeof fr>
