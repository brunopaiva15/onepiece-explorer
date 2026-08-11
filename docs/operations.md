# Exploitation

Ce document sert quand quelque chose ne va pas, ou quand il faut faire une
opération qu'on ne fait pas toutes les semaines : déployer, restaurer,
retraiter, purger. Le [README](../README.md) explique comment installer et
comment le produit fonctionne ; celui-ci suppose que c'est déjà fait.

Il est écrit pour une seule personne exploitant une seule instance — c'est la
forme du produit. Il n'y a pas d'astreinte, pas de rotation, pas de SLA. Ce qui
suit vise donc à ce que vous puissiez diagnostiquer une panne six mois après
l'avoir oubliée.

---

## Ce qui tourne

Trois choses, et chacune casse différemment.

| Processus | Commande | Ce qui se passe s'il manque |
|---|---|---|
| Interface web | `pnpm start` (ou `pnpm dev`) | Rien n'est consultable. Panne visible. |
| Worker du pipeline | `pnpm worker:once` | **Panne invisible.** L'import continue de marcher, les chapitres s'empilent en « en attente d'un worker », et l'application a l'air d'avoir un bug. |
| PostgreSQL (Supabase) | — | Tout s'arrête, y compris l'authentification. |

Le worker est le seul dont l'absence ressemble à un bug applicatif. Si un
chapitre reste bloqué, c'est le premier endroit à regarder — pas le pipeline.

Le worker fait aussi le ménage : au démarrage puis toutes les six heures, il
purge les compteurs de limitation de débit de plus de 24 h. Un worker qui n'est
jamais lancé laisse ces lignes s'accumuler dans `audit_log`. Ce n'est pas grave,
juste sale.

---

## Déployer une mise à jour

Dans cet ordre, et l'ordre compte :

```bash
git pull
pnpm install
pnpm db:push          # migrations, rôles, politiques RLS, ontologie
pnpm doctor           # vérifie que tout répond vraiment
pnpm build
# puis redémarrer les deux processus
```

La configuration se lit dans `.env.local` puis `.env`, une variable réellement
présente dans l'environnement l'emportant sur les deux — même ordre que
Next.js, et le même pour l'application, le worker et les scripts. Un hébergeur
qui injecte ses propres variables n'a donc aucun fichier à déposer.

`pnpm db:push` est idempotent : il applique les migrations manquantes, les
inscrit dans `_migrations`, et ne rejoue pas celles qui y sont déjà.

**Les migrations passent avant le nouveau code, jamais après.** Elles sont
écrites pour être compatibles avec le code précédent — une colonne ajoutée, un
index créé, une politique remplacée — de sorte que l'instant entre les deux soit
un moment où l'ancienne version tourne sur le schéma neuf, ce qui marche.
L'inverse ne marche pas.

`pnpm doctor` ne se contente pas de pinguer. Deux de ses contrôles valident une
promesse plutôt qu'une connexion :

- il ouvre une lecture sans frontière et vérifie que la base renvoie **zéro
  ligne** ;
- il vérifie que le bucket de stockage est privé.

Ces deux-là sont les seules pannes qui laisseraient l'application parfaitement
fonctionnelle tout en fuyant. S'ils échouent, arrêtez-vous là.

---

## Surveiller

Tout est dans `/reglages`, qui est une page d'exploitation déguisée en page de
réglages.

**Coût de l'IA.** Total, moyenne par chapitre, répartition par étape, écart
entre l'estimation affichée avant lancement et la dépense réelle. Un écart qui
se creuse dans un sens comme dans l'autre veut dire que le comptage de tokens
ne reflète plus ce que le pipeline envoie — typiquement après un changement de
prompt.

**Garde-fou de dépense.** Consommation de l'heure écoulée pour les trois
actions plafonnées. Un compteur qui frôle son plafond alors que vous n'avez rien
fait est le symptôme recherché : quelque chose boucle.

**Quarantaine.** C'est la distribution qui informe, pas le total. Trente
occurrences d'une même raison est un problème systématique — un prompt, un
schéma, une étape. Une occurrence de chacune de trente raisons est une mauvaise
journée du modèle, et il n'y a rien à faire.

**Échecs d'étape.** Étape, nombre de tentatives, dernière erreur. pg-boss
réessaie deux fois avec dix secondes d'écart avant d'abandonner ; ce qui
apparaît ici a donc déjà échoué trois fois.

**Faits sans source.** Des assertions dont le chapitre a été supprimé. Elles
restent dans le graphe mais ne sont plus vérifiables. Un réimport du chapitre
les recolle automatiquement — voir « Réimport » plus bas.

Pour un chapitre en particulier, `/runs/[id]` donne la progression étape par
étape, en direct, avec durée et coût réel.

---

## Sauvegarder et restaurer

Deux choses distinctes, sauvegardées différemment.

**La base** est celle de Supabase. Les sauvegardes automatiques et la
restauration à un instant donné (PITR) sont du ressort du projet Supabase, pas
de cette application ; vérifiez leur activation dans la console. C'est la seule
copie de votre graphe.

**Les pages** sont dans le bucket privé. Elles sont dérivées de vos fichiers
d'origine, que vous avez déjà : leur perte coûte un réimport, pas une
connaissance. C'est délibérément la partie non critique.

**L'export JSON** (`/api/export`, ou le bouton dans `/reglages`) contient tout
ce qui a été appris : chapitres, entités, assertions, preuves, théories,
décisions de revue. Il ne contient **pas** les pages — ce sont vos fichiers, et
un export qui les embarquerait ferait de cet outil un canal de redistribution.

Un export n'est pas une sauvegarde tant qu'il n'a pas été restauré une fois.
Il n'existe pas d'import inverse aujourd'hui : l'export est un format de
lecture et de portabilité, pas de restauration. Pour revenir en arrière, c'est
la base qu'il faut restaurer.

**Purge complète.** `purgeReader(userId)` efface tout ce qui appartient à un
lecteur, y compris ce que la suppression en cascade ne couvre pas (théories,
décisions de revue, embeddings, quarantaine, journal d'audit) **et les objets du
stockage** — pages, dérivés, illustrations. Effacer les lignes sans les octets
laisserait vos scans dans le bucket en annonçant une suppression réussie. Elle
n'est exposée par aucune route : c'est une opération qu'on exécute délibérément,
pas qu'on déclenche par un clic.

---

## Rétention

| Donnée | Conservation | Comment l'effacer |
|---|---|---|
| Pages et dérivés (stockage) | Jusqu'à suppression explicite | `/reglages` → supprimer un chapitre |
| Faits, preuves, décisions de revue | Indéfiniment, en ajout seul | Suppression de chapitre en cochant « supprimer aussi les faits » |
| Illustrations externes (bucket + lignes) | Jusqu'à suppression de l'entité | Cascade depuis l'entité ; `purgeReader` pour tout |
| Compteurs de limitation de débit | 24 h | Automatique (passe du worker) |
| Journal d'audit | Indéfiniment | `purgeReader` |
| Tout | — | `purgeReader` |

Les assertions sont en ajout seul, garanties par un déclencheur : une
correction crée une nouvelle ligne et renseigne `superseded_by`. Rien ne les
supprime sans `app.allow_destructive`, que seul le chemin de suppression de
chapitre pose, et qui écrit une entrée d'audit d'abord.

---

## Illustrations

`pnpm images:catalogue` récupère les trois catalogues (~1 000 illustrations) et
les met en cache dans `var/cache/image-catalogue.json`, valable un mois.
`pnpm images:enrich` rapproche vos entités, télécharge et range dans le bucket
privé. Le bouton de `/reglages` fait la même chose, plafonné sous le compteur
`start_run` — non pour l'argent, il n'y en a pas, mais pour ne pas marteler
trois services gratuits.

Les deux étapes sont séparées exprès : le catalogue dépend de la disponibilité
d'autrui, le rapprochement dépend de vos données. Un catalogue déjà récupéré
continue de fonctionner quand une des trois sources tombe, et la suite de tests
n'ouvre jamais de socket.

Points d'exploitation :

- **Une source injoignable dégrade, ne casse pas.** Deux catalogues sur trois
  illustrent encore l'essentiel ; l'échec est rapporté dans le résultat plutôt
  que journalisé et oublié.
- **Un catalogue vide n'écrase jamais un bon cache.** Les trois sources en échec
  veut dire réseau coupé, pas « One Piece n'a plus de personnages ».
- **AniList publie 30 requêtes par minute.** Le client se cale à une toutes les
  deux secondes ; ne le réduisez pas.
- **Rien n'est retéléchargé.** Un réenrichissement ne regarde que les entités
  sans image. Pour réexaminer les autres, `includeIllustrated`.
- **Une image sans correspondance est normale.** Un personnage secondaire, une
  désignation provisoire, un lieu absent des 31 îles du catalogue : ce sont des
  absences, pas des erreurs. La couverture par type est dans `/reglages`.
- **Une image n'est jamais une preuve.** Si un jour l'enrichissement écrivait une
  assertion, la promesse centrale du produit tomberait. Un test le vérifie.

---

## Garde-fou de dépense

Trois actions sont plafonnées par heure glissante, par lecteur :

| Action | Plafond |
|---|---|
| Question à l'assistant | 60 / h |
| Traitement de chapitre, et enrichissement d'images | 30 / h |
| Export complet | 10 / h |

L'assistant conversationnel a en plus son propre interrupteur,
`ASSISTANT_ENABLED`, **éteint par défaut**. C'est délibérément indépendant de la
clé Anthropic : traiter un chapitre est un acte volontaire au coût connu, tandis
que `/ask` facture à la question, indéfiniment. Poser une clé pour que le
pipeline lise vos pages ne doit pas ouvrir une boîte à compteur. Sans lui,
`/ask` le dit et renvoie vers la recherche, qui couvre les mêmes données
gratuitement.

La lecture, la navigation, le graphe et la recherche ne sont jamais comptés :
ils ne coûtent rien à personne. Les plafonds vivent dans
`src/domains/observability/rate-limit.ts` et sont adossés à `audit_log`, pas à
un compteur en mémoire — le worker et le serveur web sont deux processus, et un
compteur par processus mesurerait la topologie de déploiement plutôt que
l'usage.

Une tentative refusée n'est pas comptée. C'est intentionnel : la compter
signifierait qu'une boucle qui réessaie repousse indéfiniment son propre
déverrouillage.

---

## Pannes courantes

| Symptôme | Cause probable | Que faire |
|---|---|---|
| Chapitre bloqué en « en attente d'un worker » | Worker non lancé | `pnpm worker:once` |
| Second chapitre importé d'affilée jamais traité | Job dédupliqué par la file | Vérifiez que `singletonKey` vaut bien l'identifiant du chapitre ; un `stately` sans clé déduplique sur toute la file |
| « Le run est créé mais n'a pas pu être mis en file » | `DIRECT_URL` absent ou pooler utilisé à sa place | pg-boss exige la connexion directe (5432), jamais le pooler (6543) |
| 429 « Limite atteinte » | Garde-fou de dépense | Attendez le délai indiqué. S'il se déclenche sans action de votre part, cherchez la boucle avant de relever le plafond |
| Une requête renvoie zéro ligne alors que les données existent | Lecture hors `withBoundary()`, ou frontière trop basse | C'est le comportement voulu — la RLS échoue fermée. Vérifiez l'appelant |
| `prepared statement already exists` | `prepare: false` manquant sur le pooler | Le client applicatif doit le poser ; le worker n'utilise pas le pooler |
| Un réglage de session fuit d'un utilisateur à l'autre | `SET` au lieu de `SET LOCAL` | Toute variable de session doit être posée par `set_config(..., true)` dans une transaction |
| `pnpm build` réclame une base | Un module se connecte à l'import | Les clients sont des fabriques paresseuses ; une connexion au chargement du module casse le build |
| Recherche sémantique « désactivée » | Aucun fournisseur d'embeddings | Attendu. Le plein texte, l'approchant et le graphe fonctionnent sans |
| `/ask` répond qu'il est désactivé | `ASSISTANT_ENABLED` absent | Attendu, et voulu. `ASSISTANT_ENABLED=1` pour l'activer, en sachant que chaque question se facture |
| « Aucun catalogue d'images en cache » | `pnpm images:catalogue` jamais lancé | Lancez-le. L'erreur est explicite plutôt que « 0 image trouvée », qui ressemblerait à un rapprochement raté |
| Beaucoup d'entités sans image | Couverture des catalogues, pas un bug | 369 personnages et 31 îles côté onepieceapi. Un personnage secondaire n'y est pas |
| Un portrait manifestement faux | Rapprochement par nom trop permissif | La légende dit quel nom l'a trouvé. Supprimez la ligne d'`entity_images` ; le rapprochement ne la recréera pas si le nom reste ambigu |
| pgvector absent | PostgreSQL local | Attendu en test : bascule automatique sur `real[]` |
| Graphe tronqué avec un avertissement | Plus de 25 000 nœuds visibles | Le message dit combien sur combien. Filtrez par type ou baissez la frontière |
| « no space left on device » | Dérivés d'images accumulés | Supprimez des chapitres, ou purgez les dérivés du bucket |

---

## Réimport et retraitement

**Réimporter un chapitre** est sûr, et c'est le geste de réparation par défaut.
Les propositions déjà décidées ne reviennent pas en file : elles sont
reconnaissables à leur empreinte (`proposal_fingerprint`) et la décision
enregistrée est réappliquée. Vos corrections survivent.

Une conséquence a longtemps été un piège : comme la proposition ne repasse pas
en revue, aucune preuve n'était réécrite, et un fait dont le chapitre avait été
supprimé restait invérifiable pour toujours. Le rattachement
(`src/domains/pipeline/reanchor.ts`) le corrige — il retrouve l'assertion par
son empreinte et lui réinsère une preuve fraîche, sans toucher à l'assertion
elle-même. C'est pourquoi « réimportez le chapitre » est une réponse valable à
« ces faits n'ont plus de source ».

**Changer un prompt ou une version de pipeline** invalide le cache par
empreinte des étapes : les étapes concernées se rejouent et se repaient. Faites-
le sur un chapitre avant de le faire sur cent, et comparez le coût par étape
dans `/reglages` avant et après.

---

## Sécurité

Ce qui est déjà en place, pour ne pas le redéfaire ni le défaire par accident :

- **En-têtes** posés dans `next.config.ts` pour toutes les routes :
  `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `X-Frame-Options:
  DENY`, `Permissions-Policy` fermant caméra, micro et géolocalisation. Les
  routes d'assets ajoutent `Cache-Control: private, no-store` et
  `X-Robots-Tag: noindex`.
- **Les assets privés** ne sont servis que par une route authentifiée, à URLs
  signées de courte durée. Rien sous `var/` n'est exposé statiquement, et aucun
  hôte d'images distant n'est autorisé.
- **L'export** est `private, no-store` : il contient tout ce que vous avez
  appris, et un cache partagé serait le pire endroit où le poser.
- **Aucune URL extraite d'un document n'est suivie.** Le texte d'une page est
  une donnée, jamais une instruction.
- **Les secrets ne sont jamais journalisés.** `pnpm doctor` rapporte
  « défini » ou « absent », jamais une valeur.

Si vous ajoutez une route qui lit de la connaissance, elle passe par
`withBoundary()`. Une règle ESLint et
`tests/antispoiler/boundary-guards.test.ts` le vérifient tous les deux — la
seconde parce qu'une règle de lint se désactive en ligne.

---

## Intégration continue

`.github/workflows/ci.yml`, sur chaque push vers `main` et chaque pull request.
Deux jobs : types/lint/build sans base, puis la suite complète contre un
PostgreSQL 16 en conteneur de service.

Trois choses qu'il vaut mieux savoir avant de la modifier :

- **Aucun secret n'y est nécessaire, et il ne faut pas en ajouter.** Le
  fournisseur de modèle est `replay`, le stockage est local, le catalogue
  d'images est une fixture. Une CI qui dépense de l'argent finit par être
  désactivée, et une CI qui dépend de la disponibilité d'un tiers finit par être
  déclarée « instable » — après quoi la vraie régression passe inaperçue.
- **La base est créée vide à chaque exécution.** C'est ce qui fait du job le
  contrôle permanent que les migrations partent de zéro.
- **Les tests anti-spoiler tournent dans une étape séparée, avant le reste.**
  Une vingtaine de secondes de recoupement avec la suite complète, assumées :
  quand l'un des huit casse, le journal doit le dire en haut.

Les tests de performance se désactivent d'eux-mêmes en CI : le corpus 8k/60k
n'y est pas généré, et le fichier le détecte. Pour les lancer,
`pnpm fixtures:graph` puis `pnpm test:perf`, en local.

---

## Avant de considérer une modification terminée

```bash
pnpm typecheck && pnpm lint
pnpm test              # unitaires + intégration
pnpm test:antispoiler  # les scénarios bloquants
pnpm build
```

Et, sur les fixtures, le parcours complet sans clé API :

```bash
pnpm demo
```

Il importe trois chapitres synthétiques, les traite, publie tout sans revue, et
imprime le même graphe lu depuis trois endroits de l'histoire. Si la frontière
est cassée, cela se voit à l'œil dans sa sortie : les trois lectures deviennent
identiques.
