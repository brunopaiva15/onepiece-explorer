# Critères d'acceptation

Une fonctionnalité n'est pas terminée tant que ces critères ne sont pas vérifiés.
Les critères marqués **bloquant** font échouer la CI.

Une case cochée signifie qu'un test, un déclencheur ou une politique le vérifie —
pas qu'on s'en est convaincu. Ce qui reste décoché est décoché exprès, et dit
pourquoi. Une liste tout entière cochée serait le premier signe qu'elle a cessé
d'être lue.

## Transversaux

- [x] Le code est typé (`pnpm typecheck` passe), lisible, et couvert par des tests.
- [x] Les migrations s'appliquent sur le PostgreSQL local à partir de zéro — vérifié à chaque exécution de CI, sur une base créée vide (`.github/workflows/ci.yml`).
- [x] La CI existe et fait échouer les scénarios bloquants — sans secret, sans clé API, sans accès réseau.
- [ ] Les mêmes migrations s'appliquent sur Supabase à partir de zéro. Un seul jeu de migrations, mais aucun projet Supabase n'a encore été joint : à vérifier au premier déploiement, avec `pnpm doctor`.
- [x] Chaque erreur possible a un état d'interface utile : ce qui a échoué, et l'action précise possible.
- [x] Les jobs sont idempotents et reprenables ; rejouer une étape inchangée ne duplique rien — `tests/pipeline/run-chapter.test.ts`.
- [x] Toute sortie de modèle est validée par un schéma JSON strict ; le non conforme part en quarantaine — `tests/ai/providers.test.ts`, `tests/antispoiler/evidence-anchoring.test.ts`.
- [x] Aucun faux bouton, aucune donnée codée en dur présentée comme réelle.

## Anti-spoiler — **bloquant**

Les huit scénarios de `tests/antispoiler/`, exactement ceux du cahier des charges :

| # | Scénario | Vérifié par |
|---|---|---|
| 1 | Une identité révélée au chapitre 30 est absente de la projection au chapitre 29. | `temporal-projection.test.ts` |
| 2 | Un vrai nom apparaît au chapitre 50 : l'ancien alias reste affiché au chapitre 49. | `temporal-projection.test.ts` |
| 3 | Une croyance explicite est réfutée plus tard : les deux assertions restent historisées et chacune est visible à sa propre frontière. | `temporal-projection.test.ts` |
| 4 | Le modèle propose une information connue de ses données d'entraînement mais absente des sources : la proposition est mise en quarantaine, jamais insérée. | `evidence-anchoring.test.ts` |
| 5 | Une page contient une fausse instruction destinée au modèle : elle est traitée comme du texte narratif, sans effet système. | `evidence-anchoring.test.ts`, `tests/ingestion/pdf-extraction.test.ts` |
| 6 | Une correction humaine est conservée après réimport du même chapitre. | `entity-resolution.test.ts` |
| 7 | Deux personnages similaires restent distincts tant que la fusion n'est pas validée. | `entity-resolution.test.ts` |
| 8 | Chaque réponse conversationnelle cite une preuve autorisée, ou déclare explicitement que les données sont insuffisantes. | `assistant-citations.test.ts` |

Plus deux gardes structurelles :

- [x] **Bloquant** — aucun module hors `src/db/` n'obtient de connexion sans passer par `withBoundary()` — `boundary-guards.test.ts`, doublé d'une règle ESLint.
- [x] **Bloquant** — une lecture d'une table protégée exécutée hors `withBoundary()` renvoie **zéro ligne**, pas des données — `boundary-guards.test.ts`, et `pnpm doctor` le revérifie sur la base réelle.

Une élévation de la portée d'une recherche ne peut pas élever la portée d'une
lecture : le repli disjonctif de l'assistant est testé à ce titre dans
`assistant-citations.test.ts`.

## Provenance

- [x] Tout fait affiché peut montrer sa provenance : chapitre, page, case, extrait.
- [x] Une inférence n'est jamais présentée comme un fait : le statut épistémique est visible, et jamais porté par la seule couleur.
- [x] « Pourquoi ces deux nœuds sont-ils reliés ? » affiche les assertions et leurs preuves.
- [ ] Une biographie renvoie chaque phrase à ses assertions sources. L'étape `summarize_chapter` est déclarée et non implémentée : un résumé écrit avant la revue résumerait des propositions non validées. À produire après publication, avec le delta narratif.

## Qualité de l'extraction

Mesurée contre la vérité-terrain des fixtures synthétiques :

- [x] OCR : la couche texte des PDF est récupérée **exactement**, ligne par ligne, contre la vérité-terrain du générateur — `tests/ingestion/pdf-extraction.test.ts`.
- [ ] Précision et rappel OCR enregistrés à chaque exécution, régression signalée. Le contrôle exact ci-dessus est binaire ; il n'y a pas encore de métrique suivie dans le temps, et elle ne vaudra que le jour où la transcription passera par `tesseract.js` ou par un modèle plutôt que par la couche texte.
- [x] Ordre de lecture des cases : conforme au sens choisi — `tests/ingestion/panel-detection.test.ts`, droite-vers-gauche et gauche-vers-droite.
- [x] Exactitude des citations : l'extrait cité est bien dans le bloc cité — l'ancrage est un filtre de code doublé d'un déclencheur en base.
- [x] Taux d'hallucination consultable : la quarantaine est affichée par raison dans `/reglages`, et c'est la distribution qui diagnostique.
- [ ] Taux d'hallucination suivi **dans le temps**. Aujourd'hui c'est un instantané ; comparer deux versions de prompt demande de le relever à la main.
- [x] Stabilité : retraiter deux fois le même chapitre ne duplique rien et ne repose pas les questions déjà tranchées — `tests/pipeline/run-chapter.test.ts`.
- [x] Un chapitre peut porter sa version dans l'autre langue. Elle est fournie à l'extraction pour le nommage — « source_term » et « naming_confident » lus dans la mise en regard plutôt que devinés — et n'est **jamais** citable : elle n'a pas de passages, donc pas de références, donc rien qui puisse l'ancrer — `tests/ingestion/summary.test.ts`, `tests/ai/providers.test.ts`.
- [x] Un chapitre dont plus aucune proposition n'est en attente est marqué relu et ouvert au lecteur. Sans cela ses faits existent et restent invisibles : la frontière du lecteur ne compte que les chapitres publiés — `tests/ingestion/summary.test.ts`.
- [x] Une question de nom posée par le modèle est tranchée une fois : accepter la forme proposée telle quelle vaut réponse et alimente le glossaire, au même titre qu'une correction — mais une entité dont le modèle était sûr ne règle rien — `tests/review/glossary.test.ts`.
- [x] Un nom retapé pendant la revue est repris dans les résumés d'événement et les questions de mystère du même lot, qui l'avaient écrit avant votre décision.
- [x] Un nom se corrige depuis la fiche, une fois la revue passée : la correction réécrit le libellé **sans déplacer son chapitre de révélation** — un nom daté d'aujourd'hui ouvrirait dans le curseur un trou où l'entité n'aurait pas eu de nom —, garde l'ancienne graphie comme nom de recherche que rien n'affiche, et entre au glossaire pour la formulation source du même nœud aussi, qui est ce qu'un chapitre suivant contiendra. Corriger une graphie de recherche ne règle en revanche aucun vocabulaire : le glossaire répond « comment on l'appelle », et ce nom-là n'a pas bougé. La correction ne s'arrête pas au libellé : un événement est nommé par son résumé et un mystère par sa question, donc ces phrases-là suivent — mots entiers seulement, jamais à l'intérieur d'un mot plus long —, ainsi que la copie tronquée que la recherche indexe ; le texte du chapitre n'est en revanche **jamais** retouché, c'est ce que la source dit et ce à quoi les preuves s'ancrent. Corriger une ligne vers un nom que l'entité porte déjà — le cas ordinaire, un chapitre ultérieur ayant reproposé l'ancienne graphie — **réunit les deux en un seul nom** plutôt que d'être refusé : la ligne survivante garde la plus forte précédence de la paire, donc un affichage choisi n'est jamais rétrogradé, et la **plus ancienne** révélation, parce que l'entité portait bien ce nom à ce chapitre-là, mal orthographié. Le libellé est relu par propriétaire avant d'être touché — l'action est un point d'entrée public, et le rôle d'ingestion ignore les politiques de ligne — `tests/knowledge/rename.test.ts`.
- [x] Un rapprochement accepté **fusionne** : la proposition devient une nouvelle apparition de l'entité déjà publiée, les faits du chapitre se rattachent à elle, aucun second nœud n'est créé, et le nom sous lequel le chapitre l'a désignée est enregistré sous celui que vous aviez tranché — un rapprochement ne renomme personne. La carte de l'entité renvoie vers le rapprochement qui la décide, et la revue automatique laisse les deux debout : accepter une entité dont le rapprochement dort est précisément ce qui fabrique le doublon — `tests/review/merge.test.ts`, `tests/review/auto.test.ts`.
- [x] L'objet d'une relation est une entité : une phrase glissée dans cette place — « Kuina · meurt à · "Kuina meurt en tombant dans un escalier" » — ne relie rien et ne se retrouve pas depuis l'autre bout, elle part en quarantaine avec la raison, et le prompt dit que ce qui s'écrit en une phrase est un événement. Seul un prédicat qui ne déclare aucun type d'objet — donc jamais un prédicat livré — admet une valeur — `tests/antispoiler/evidence-anchoring.test.ts`.
- [x] Un prédicat s'affiche en français partout où il se lit — graphe, fiches, chronologie, recherche, revue — depuis le `labelFr` que l'ontologie porte déjà et qui sert à le proposer au modèle ; un prédicat inconnu est rendu lisible, jamais traduit d'office — `tests/knowledge/predicate-label.test.ts`.
- [x] La fiche d'une entité nomme l'autre bout de chacun de ses faits ; « entité sans nom révélé » n'apparaît que lorsque aucun nom n'est effectivement révélé à la frontière lue — `tests/temporal/entity-sheet.test.ts`.
- [x] Les copies d'une même proposition à l'intérieur d'un traitement — le coût assumé du découpage en tranches — sont signalées dans le centre de revue avec ce qui a déjà été décidé sur chacune, y compris une copie acceptée lors d'une publication antérieure ; le rapprochement des entités porte sur la formulation source et non sur le libellé français, sans quoi une entité traduite deux fois différemment passe pour deux propositions ; les relations sont rapprochées par les entités qu'elles relient et non par des identifiants propres à une tranche, et les événements — seule catégorie sans identité stable — par le recouvrement de leurs mots pleins ; dès qu'une copie est acceptée les autres partent en « reporter » sans être présentées, et l'acceptation en lot n'en retient qu'une — `tests/review/duplicates.test.ts`, `tests/review/duplicate-queue.test.ts`.

- [x] Un intervalle de chapitres est récupéré en une fois, et un trou au milieu n'emporte pas le lot : chaque chapitre revient avec ses résumés ou avec sa raison, dans l'ordre des chapitres et non dans celui des réponses — l'ordre est celui dans lequel la file les traitera. Un intervalle à l'envers est refusé plutôt que remis à l'endroit, et rien n'est demandé au wiki dans ce cas — `tests/ingestion/fandom-range.test.ts`.
- [x] Les chapitres d'un lot sont **traités un par un**, chacun au moment où le précédent est publié — seule la publication met dans le graphe ce que le rapprochement compare. La file est une donnée (`chapters.queued_for_run`), jamais « le prochain chapitre sans traitement », qui ramasserait un chapitre importé avec « lancer le traitement » décoché ; deux publications simultanées ne peuvent pas réclamer le même chapitre ; un traitement refusé — la limite horaire — remet le chapitre dans la file au lieu d'arrêter la chaîne en silence — `tests/pipeline/queue.test.ts`.

## Sécurité et confidentialité

- [x] Les assets privés ne sont jamais accessibles publiquement ; les URLs signées expirent — `tests/storage/`, et `pnpm doctor` vérifie que le bucket est privé.
- [x] Validation MIME par le contenu, pas par l'extension — `tests/ingestion/hostile-uploads.test.ts`.
- [x] Protection ZIP Slip, bombes de décompression, archives imbriquées, chemins malveillants — même fichier, y compris les entrées qui mentent sur leur taille.
- [x] Aucun appel réseau fondé sur une URL extraite d'un document.
- [x] Les secrets restent côté serveur ; aucun n'atteint le navigateur, et `pnpm doctor` rapporte « défini » ou « absent », jamais une valeur.
- [x] Export et suppression complète des données possibles — `tests/lifecycle/deletion-and-export.test.ts`.
- [x] Journal d'audit sur les décisions de revue et les publications.
- [x] En-têtes de sécurité sur toutes les routes ; `private, no-store` sur les assets et sur l'export.
- [x] Les opérations coûteuses sont plafonnées par heure, par lecteur, et le plafond survit à un redémarrage — `tests/lifecycle/rate-limit.test.ts`.
- [x] L'assistant facturé à la question a son propre interrupteur, éteint par défaut : une clé posée pour le pipeline ne l'allume pas.
- [x] La purge complète efface aussi les octets — pages, dérivés, illustrations — et pas seulement les lignes qui les désignent.

## Performance

- [x] Graphe utilisable à 8 000 nœuds / 60 000 arêtes : premier rendu et interaction mesurés, budget documenté — `tests/perf/graph-budget.test.ts`.
- [x] Une projection tronquée le dit. Un graphe silencieusement amputé des trois quarts de l'œuvre ressemble exactement à un graphe complet.
- [x] Le layout ne bloque pas le thread principal.
- [x] Une alternative accessible (tableau) applique exactement le même filtrage — `/graph/table`.

## Coût

- [x] L'estimation affichée avant lancement provient d'un `countTokens()` réel, jamais d'une constante.
- [x] Le coût réel est enregistré par étape et consultable dans `/reglages`, avec l'écart à l'estimation.

## Suppression de chapitre

- [x] Avertit clairement des faits et résumés qui en dépendent, avant confirmation, avec les comptes.
- [x] Recalcule proprement, ou marque les assertions orphelines pour revue. L'état d'orphelin est **dérivé** — acceptée, sans preuve — jamais stocké : un état stocké se désynchronise d'un réimport.
- [x] Ne laisse jamais silencieusement un fait sans preuve : ils sont listés dans `/reglages`, et un réimport les recolle.

## Illustrations externes

Les images viennent de trois catalogues publics ; la connaissance, jamais.

- [x] Une image n'est jamais une preuve : aucune assertion ne peut la citer, et l'enrichissement n'écrit ni assertion ni evidence — `tests/antispoiler/entity-images.test.ts`.
- [x] **Bloquant** — une image n'apparaît pas avant le chapitre qui révèle le libellé l'ayant trouvée, et une lecture hors `withBoundary()` en renvoie zéro — même fichier.
- [x] Aucun rapprochement silencieux sur un signal faible : type de nœud respecté, mononyme ambigu refusé, marge exigée sur la similarité — `tests/images/matching.test.ts`.
- [x] Le catalogue d'illustrations se met en cache là où le code tourne réellement, et un cache impossible à écrire coûte un rechargement, jamais le catalogue déjà en main : sur un déploiement en lecture seule, l'échec de `mkdir` remontait jusqu'au bouton et laissait la bibliothèque entièrement sans illustration — `tests/images/catalogue.test.ts`.
- [x] Une quinzaine d'entités sont illustrées sans qu'on le demande à chaque chapitre ouvert à la lecture, après la réponse : une illustration n'est pas une connaissance, elle ne demande pas de décision — seulement un moment.
- [x] Chaque image affiche sa source, son attribution et le nom qui l'a trouvée. Un visage sans provenance se lirait comme un résultat du pipeline.
- [x] Les fichiers sont recopiés dans le bucket privé, servis par URL signée courte, jamais chargés depuis un tiers.
- [x] L'enrichissement est rejouable : ni doublon, ni portrait principal en double.
- [x] Les tests n'ouvrent aucune connexion réseau ; le catalogue est une fixture.
- [ ] Couverture complète. Impossible : les catalogues gratuits plafonnent à 369 personnages, 94 fruits, 16 navires et 31 îles. Les absences sont affichées par type dans `/reglages` plutôt que passées sous silence.

## Lecture publique

Ouverte seulement si `PUBLIC_LIBRARY_OWNER_ID` est posée sur une bibliothèque existante.

- [x] **Bloquant** — un visiteur ne peut atteindre aucune image de page ni de case : la route d'assets exige une authentification et une clé sous le préfixe de l'appelant — `tests/antispoiler/public-reading.test.ts`.
- [x] **Bloquant** — aucun chemin d'écriture ne passe par la session visiteur : vérifié structurellement sur les sept actions et routes, avec garde contre un glob qui ne trouverait rien.
- [x] La frontière s'applique au visiteur exactement comme au propriétaire — même politique RLS, même colonne, pas de second chemin plus permissif.
- [x] Éteinte par défaut, et une valeur mal formée est traitée comme absente. Une faute de frappe rend le site privé, jamais à moitié ouvert.
- [x] La position de lecture du propriétaire n'est jamais exposée : celle du visiteur vient de l'URL.
- [x] Un identifiant qui ne correspond à rien donne un site vide, pas une erreur 500.
- [x] Import, revue, publication, suppression, export, enrichissement et assistant restent réservés au propriétaire.

## Exploitation

- [x] Une documentation d'exploitation existe : déploiement, surveillance, sauvegarde, rétention, pannes courantes — [docs/operations.md](operations.md).
- [x] Le parcours complet est exécutable sans clé API et sans navigateur — `pnpm demo`.
- [ ] Tests de navigateur (Playwright). Non écrits, et non prévus tant qu'ils exigeraient un projet Supabase joignable : la suite perdrait l'hermétisme qui permet aux tests anti-spoiler d'être bloquants.
