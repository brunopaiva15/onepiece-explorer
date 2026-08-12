import type { Locale } from '../index.ts'

/** Strings for the etat area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  metaTitle: 'État du déploiement',
  title: 'État du déploiement',

  // Shape problems of NEXT_PUBLIC_SUPABASE_URL, in the terms of the fix
  urlQuoted: 'entourée de guillemets — retirez-les',
  urlNotUrl:
    "définie, mais ce n'est pas une URL valide — attendu https://<ref>.supabase.co",
  urlNoScheme:
    'définie, mais sans « https:// » — attendu https://<ref>.supabase.co',
  urlBadScheme: (protocol: string) => `schéma « ${protocol}// » — attendu https://`,
  urlNoDomain: 'hôte sans domaine — attendu https://<ref>.supabase.co',

  // Check details
  requiredMissing: 'ABSENTE — chaque page échouera',
  present: 'définie',
  vercelWarn:
    "présente hors déploiement — vient probablement de `vercel env pull`. Supprimez les lignes VERCEL* de .env.local : elles plafonneraient l'import à 4,5 Mo.",
  serviceRoleMissing:
    "absente — l'import et l'affichage des pages échoueront, la lecture du graphe non",
  anthropicMissing: 'absente — extraction synthétique, avec bannière',
  assistantMissing: 'absente — /ask est éteint, et rien ne se facture',
  publicIdMissing: 'absente — le site est privé',
  appConnectionLabel: 'Connexion applicative (DATABASE_URL)',
  directConnectionLabel: 'Connexion directe (DIRECT_URL)',
  answers: 'répond',
  schemaLabel: 'Schéma de la base',
  schemaUpToDate: (count: number, last: string | null) =>
    `à jour — ${count} migration(s), la dernière étant ${last ?? 'inconnue'}`,
  schemaBehind: (tables: string[], last: string | null) =>
    `EN RETARD — table(s) absente(s) : ${tables.join(', ')}. ` +
    `Dernière migration appliquée : ${last ?? 'aucune'}.`,

  intro:
    "Cette page ne dépend d'aucune des choses qu'elle contrôle : ni de la configuration validée, ni d'une session, ni du client Supabase. C'est ce qui lui permet de répondre quand tout le reste renvoie une erreur serveur. Elle n'affiche jamais une valeur — seulement si elle est là.",
  allOk:
    "Tout répond et le schéma est à jour. Si une page échoue malgré ça, le message complet est dans les journaux d'exécution de l'hébergeur — la page en erreur affiche une référence à y chercher.",
  problemCount: (n: number) => `${n} problème(s) à corriger.`,

  // The schema-behind help paragraph, split around its <code> elements
  schemaFixLead: 'Le schéma est en retard sur le code. Depuis votre machine, avec le',
  schemaFixMid: 'de production dans',
  schemaFixColon: ' :',
  schemaFixThen: ', puis',
  schemaFixTail:
    ". Rien ne l'applique au déploiement : c'est délibéré — une migration qui s'exécute à chaud pendant qu'une ancienne version tourne encore est le pire moment pour la lancer.",

  // Usual causes
  causesHeading: "Les causes habituelles, dans l'ordre",
  andWord: 'et',
  cause1Strong: 'Un caractère réservé dans le mot de passe.',
  cause1Lead: "Une chaîne de connexion est une URL, et l'URL réserve",
  cause1Mid:
    '. Un mot de passe qui en contient un rend la chaîne illisible sans que rien ne dise lequel. Encodez-le dans la chaîne —',
  cause1Tail: ' — sans toucher au mot de passe dans Supabase.',
  cause2Strong: 'Une variable manquante au moment du build.',
  cause2Mid:
    'sont insérées dans le bundle à la compilation. Les ajouter après un déploiement ne suffit pas : il faut',
  redeployEm: 'redéployer',
  cause2Tail:
    ". Vérifiez aussi qu'elles couvrent l'environnement déployé (Production comme Preview).",
  cause3Strong: 'La mauvaise chaîne de connexion.',
  cause3Lead: 'La connexion vraiment directe de Supabase',
  cause3Mid:
    "est en IPv6 uniquement et un hébergeur en IPv4 ne l'atteindra jamais. Utilisez les chaînes du",
  cause3Mid2: ' : port 6543 en mode transaction pour',
  cause3Mid3: ', port 5432 en mode session pour',
  cause4Strong: 'Un schéma en retard.',
  cause4Lead: "Les migrations ne s'appliquent pas au déploiement. Lancez",
  cause4Mid: 'depuis votre machine avec le',
  cause4Mid2: ' de production, puis',
  closingLead:
    "La cause 2 ne concerne qu'un déploiement : en local, les variables sont relues à chaque démarrage — il suffit de redémarrer",
  closingMid: '. Et sur votre machine,',
  closingTail:
    " dit la même chose que cette page en plus détaillé : il essaie chaque connexion et affiche l'hôte qu'il a réellement extrait.",

  backHome: "Retour à l'accueil",
}

const en: typeof fr = {
  metaTitle: 'Deployment status',
  title: 'Deployment status',

  urlQuoted: 'wrapped in quotes — remove them',
  urlNotUrl: 'set, but not a valid URL — expected https://<ref>.supabase.co',
  urlNoScheme:
    'set, but without “https://” — expected https://<ref>.supabase.co',
  urlBadScheme: (protocol: string) => `scheme “${protocol}//” — expected https://`,
  urlNoDomain: 'host without a domain — expected https://<ref>.supabase.co',

  requiredMissing: 'MISSING — every page will fail',
  present: 'set',
  vercelWarn:
    'present outside a deployment — probably from `vercel env pull`. Remove the VERCEL* lines from .env.local: they would cap imports at 4.5 MB.',
  serviceRoleMissing:
    'missing — importing and page display will fail, reading the graph will not',
  anthropicMissing: 'missing — synthetic extraction, with a banner',
  assistantMissing: 'missing — /ask is off, and nothing gets billed',
  publicIdMissing: 'missing — the site is private',
  appConnectionLabel: 'Application connection (DATABASE_URL)',
  directConnectionLabel: 'Direct connection (DIRECT_URL)',
  answers: 'answers',
  schemaLabel: 'Database schema',
  schemaUpToDate: (count: number, last: string | null) =>
    `up to date — ${count} migration${count === 1 ? '' : 's'}, the latest being ${last ?? 'unknown'}`,
  schemaBehind: (tables: string[], last: string | null) =>
    `BEHIND — missing table${tables.length === 1 ? '' : 's'}: ${tables.join(', ')}. ` +
    `Last migration applied: ${last ?? 'none'}.`,

  intro:
    'This page depends on none of the things it checks: not the validated configuration, not a session, not the Supabase client. That is what lets it answer when everything else returns a server error. It never shows a value — only whether one is there.',
  allOk:
    "Everything answers and the schema is up to date. If a page still fails despite that, the full message is in the host's runtime logs — the failing page shows a reference to look for there.",
  problemCount: (n: number) => `${n} problem${n === 1 ? '' : 's'} to fix.`,

  schemaFixLead: 'The schema is behind the code. From your machine, with the production',
  schemaFixMid: 'in',
  schemaFixColon: ':',
  schemaFixThen: ', then',
  schemaFixTail:
    '. Nothing applies it on deployment: that is deliberate — a migration running hot while an old version is still serving is the worst moment to launch it.',

  causesHeading: 'The usual causes, in order',
  andWord: 'and',
  cause1Strong: 'A reserved character in the password.',
  cause1Lead: 'A connection string is a URL, and URLs reserve',
  cause1Mid:
    '. A password containing one makes the string unreadable, with nothing saying which character is at fault. Encode it inside the string —',
  cause1Tail: ' — without touching the password in Supabase.',
  cause2Strong: 'A variable missing at build time.',
  cause2Mid:
    'are inlined into the bundle at build time. Adding them after a deployment is not enough: you must',
  redeployEm: 'redeploy',
  cause2Tail:
    '. Also check that they cover the deployed environment (Production as well as Preview).',
  cause3Strong: 'The wrong connection string.',
  cause3Lead: "Supabase's genuinely direct connection",
  cause3Mid:
    'is IPv6-only and an IPv4 host will never reach it. Use the',
  cause3Mid2: ' strings: port 6543 in transaction mode for',
  cause3Mid3: ', port 5432 in session mode for',
  cause4Strong: 'A schema that is behind.',
  cause4Lead: 'Migrations are not applied on deployment. Run',
  cause4Mid: 'from your machine with the production',
  cause4Mid2: ', then',
  closingLead:
    'Cause 2 only concerns a deployment: locally, the variables are re-read on every start — just restart',
  closingMid: '. And on your machine,',
  closingTail:
    ' says the same thing as this page in more detail: it tries each connection and shows the host it actually extracted.',

  backHome: 'Back to home',
}

export const etat = { fr, en } satisfies Record<Locale, typeof fr>
