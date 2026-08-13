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

## Où ça tourne, et pourquoi c'est le premier réglage de performance

`vercel.json` épingle les fonctions à **`fra1`** (Francfort), parce que la base
Supabase est sur `aws-0-eu-central-1`. Ce n'est pas un détail de confort.

Une page rend côté serveur et ouvre une dizaine de transactions bornées, chacune
faisant plusieurs allers-retours vers Postgres. Avec la fonction et la base dans
la même région, un aller-retour coûte une poignée de millisecondes et la page
sort en moins de 300 ms. Avec la fonction aux États-Unis et la base à Francfort,
le même aller-retour coûte 80 à 150 ms — et cinquante allers-retours séquentiels
font plusieurs secondes, sans qu'aucune requête ne soit lente. La région par
défaut d'un projet Vercel est américaine ; c'est de loin la cause la plus
probable d'une navigation qui traîne.

Si vous déplacez le projet Supabase, changez `regions` en même temps. Les deux
valeurs doivent désigner le même continent, sinon tout le reste de cette page
est du réglage de détail sur un problème qui se compte en centaines de
millisecondes par requête.

---

## Ce qui tourne

Deux choses.

| Processus | Commande | Ce qui se passe s'il manque |
|---|---|---|
| Interface web | `pnpm start` (ou `pnpm dev`) | Rien n'est consultable. Panne visible. |
| PostgreSQL (Supabase) | — | Tout s'arrête, y compris l'authentification. |

**Il n'y a plus de worker.** Le pipeline d'un chapitre écrit tient dans une
invocation : l'import crée le run et `after()` laisse le traitement se
poursuivre après le départ de la réponse. La file de jobs a été retirée avec le
processus qui la consommait — voir
[ADR 0008](adr/0008-the-chapter-is-a-text-you-write.md) pour ce que cela
abandonne.

Ce qui disparaît avec le worker : sa passe de ménage, qui purgeait les compteurs
de limitation de débit de plus de 24 h dans `audit_log`. Ces lignes s'accumulent
maintenant. Ce n'est pas grave, juste sale — quelques lignes par traitement
lancé.

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
Next.js, et le même pour l'application et les scripts. Un hébergeur
qui injecte ses propres variables n'a donc aucun fichier à déposer.

### Appliquer les migrations sans machine locale

`Actions → Migrations (production) → Run workflow`, en tapant `PRODUCTION`
dans le champ de confirmation. Déclenchement manuel uniquement — jamais sur un
push, jamais sur un merge, jamais planifié.

Prérequis, une fois : le secret de dépôt `PRODUCTION_DIRECT_URL`
(Settings → Secrets and variables → Actions), contenant la chaîne du pooler
Supabase **en mode session**, port 5432 sur l'hôte du pooler. Le DDL ne passe pas
par le pooler en mode transaction, et l'hôte `db.…` est en IPv6 uniquement.

Rejouable sans risque : `db:push` retient une empreinte par migration et saute
ce qui est déjà appliqué. Une migration dont le fichier a changé après
application est refusée plutôt que rejouée — une base et un dépôt qui ne sont
pas d'accord sur le schéma est pire qu'un job en échec.

La confirmation tapée n'est pas de la cérémonie : c'est la production, et un
clic mal placé ne doit pas y arriver. Elle est vérifiée avant toute
installation, donc une mauvaise réponse ne coûte rien.

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

**Échecs d'étape.** Étape, nombre de tentatives, dernière erreur. Le pipeline
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
| Compteurs de limitation de débit | 24 h | Manuel : plus de passe de ménage automatique |
| Journal d'audit | Indéfiniment | `purgeReader` |
| Tout | — | `purgeReader` |

Les assertions sont en ajout seul, garanties par un déclencheur : une
correction crée une nouvelle ligne et renseigne `superseded_by`. Rien ne les
supprime sans `app.allow_destructive`, que seul le chemin de suppression de
chapitre pose, et qui écrit une entrée d'audit d'abord.

---

## Importer, et pourquoi pas depuis un hébergeur serverless

Un chapitre arrive par une **server action**, donc dans le corps d'une requête
HTTP. C'était la contrainte structurante du projet : Next.js plafonne ce corps à
1 Mo par défaut, une plate-forme serverless impose le sien par-dessus — **4,5 Mo
sur Vercel**, non réglable — et un chapitre en PDF faisait dix à cent fois cela.
L'import ne pouvait donc pas tourner sur l'hébergeur.

**Cette contrainte a disparu avec le fichier.** Un chapitre écrit fait quelques
milliers de caractères ; le plafond de transport n'est plus jamais approché, et
`/import` fonctionne sur Vercel comme ailleurs.

Ce qui reste à surveiller n'est plus la taille mais la **durée**. Le traitement
s'exécute après le départ de la réponse, sur la même invocation, et une
plate-forme serverless finit par la tuer. Le plafond se règle par route
(`maxDuration`) et dépend du plan. Un chapitre écrit tient largement dedans —
une ou deux extractions, quelques comparaisons d'identité — mais si une
invocation est coupée, le run est marqué en échec et il faut le relancer à la
main. Ce n'est pas cher : `run_checkpoints` rejoue les tranches déjà payées au
lieu de les racheter.

### Les plafonds de stockage, qui arrivent avant tout le reste

Plan gratuit Supabase : **50 Mo par fichier** (non relevable) et **1 Go au
total**, soit de l'ordre de 25 à 60 chapitres. C'est la limite qui se fera
sentir en premier, avant toute question d'architecture d'envoi.

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

## Lecture publique

`PUBLIC_LIBRARY_OWNER_ID` sur l'identifiant affiché dans `/reglages`, puis
redéploiement. Absente, le site est privé — c'est le défaut et l'état de repli
de toute erreur de saisie.

- **Le graphe est public, les pages ne le sont pas.** C'est la ligne, et elle
  est structurelle : les images passent par une route authentifiée qui vérifie
  aussi que la clé est sous le préfixe de l'appelant. Aucun visiteur ne la
  franchit, connecté ou non.
- **`/ask` reste réservé au propriétaire**, même quand l'assistant est activé.
  Un visiteur y dépenserait votre argent à la question, et le compteur de débit
  est indexé sur votre identifiant.
- **Coupez les inscriptions Supabase** (Authentication → Sign In / Providers →
  « Allow new users to sign up »), sinon n'importe qui crée un compte. Il
  obtiendrait sa propre bibliothèque vide — pas la vôtre, la RLS cloisonne —
  mais consommerait votre stockage et vos quotas.
- **Le curseur du visiteur vient de l'URL.** Une vue est donc partageable par
  lien, et votre propre position de lecture n'est jamais affichée.

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
un compteur en mémoire — plusieurs invocations tournent en parallèle, et un
compteur par processus mesurerait la topologie de déploiement plutôt que
l'usage.

Une tentative refusée n'est pas comptée. C'est intentionnel : la compter
signifierait qu'une boucle qui réessaie repousse indéfiniment son propre
déverrouillage.

---

## Toutes les pages renvoient une erreur serveur

Ouvrez **`/etat`**. Cette page ne dépend d'aucune des choses qu'elle contrôle —
ni configuration validée, ni session, ni client Supabase — donc elle répond
quand rien d'autre ne répond, et elle dit quelle variable manque. Elle
n'affiche jamais une valeur.

La cause la plus fréquente sur un premier déploiement, et la plus déroutante :
`NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` sont **insérées
dans le bundle à la compilation**. Les ajouter au tableau de bord après un
déploiement ne change rien à ce qui tourne : il faut **redéployer**. Vérifiez
aussi qu'elles couvrent l'environnement servi — Production et Preview sont
distincts.

Reproduit et vérifié : bundle construit sans ces deux variables, `/etat` répond
200 et nomme les six manques, toutes les autres pages renvoient 500.

---

## Pannes courantes

| Symptôme | Cause probable | Que faire |
|---|---|---|
| **Toutes** les pages en erreur serveur | Variables absentes au moment du build | `/etat`, puis redéployez après les avoir enregistrées |
| Une seule page en erreur serveur | Schéma en retard sur cette table | `pnpm db:push` avec le `DIRECT_URL` de production |
| Run coupé en plein traitement, sans erreur de pipeline | Invocation tuée au plafond de durée | Relancez : les tranches déjà payées sont rejouées, pas rachetées |
| 429 « Limite atteinte » | Garde-fou de dépense | Attendez le délai indiqué. S'il se déclenche sans action de votre part, cherchez la boucle avant de relever le plafond |
| Une requête renvoie zéro ligne alors que les données existent | Lecture hors `withBoundary()`, ou frontière trop basse | C'est le comportement voulu — la RLS échoue fermée. Vérifiez l'appelant |
| `prepared statement already exists` | `prepare: false` manquant sur le pooler | Le client applicatif doit le poser ; le pipeline n'utilise pas le pooler |
| Un bouton reste sur « … » indéfiniment, puis toute l'instance se fige | Deux connexions demandées au pool d'ingestion pour une seule opération | Redéployez pour libérer l'instance. `withIngest()` est réentrant : un appel imbriqué rejoint la transaction ouverte. Ce qui provoque cela, c'est un chemin qui contourne le wrapper |
| `remaining connection slots are reserved for roles with the SUPERUSER attribute` (53300), sur toutes les pages à la fois | Plus de connexions ouvertes que la base n'en a, toutes instances confondues | Attendez : les instances tièdes rendent les leurs après 5 s d'inactivité. Les pools sont dimensionnés par instance (`DB_POOL_MAX`, `DB_INGEST_POOL_MAX`) et une fenêtre du mode histoire en tient trois. Si cela revient, cherchez ce qui multiplie les rendus — une commande d'interface qui navigue à chaque pas plutôt qu'à la fin du geste — ou une lecture qui tient deux connexions à la fois (`tests/db/reader-pool.test.ts`) |
| Un réglage de session fuit d'un utilisateur à l'autre | `SET` au lieu de `SET LOCAL` | Toute variable de session doit être posée par `set_config(..., true)` dans une transaction |
| `pnpm build` réclame une base | Un module se connecte à l'import | Les clients sont des fabriques paresseuses ; une connexion au chargement du module casse le build |
| Recherche sémantique « désactivée » | Aucun fournisseur d'embeddings | Attendu. Le plein texte, l'approchant et le graphe fonctionnent sans |
| `/ask` répond qu'il est désactivé | `ASSISTANT_ENABLED` absent | Attendu, et voulu. `ASSISTANT_ENABLED=1` pour l'activer, en sachant que chaque question se facture |
| « Aucun catalogue d'images en cache » | `pnpm images:catalogue` jamais lancé | Lancez-le. L'erreur est explicite plutôt que « 0 image trouvée », qui ressemblerait à un rapprochement raté |
| Beaucoup d'entités sans image | Couverture des catalogues, pas un bug | 369 personnages et 31 îles côté onepieceapi. Un personnage secondaire n'y est pas |
| Un portrait manifestement faux | Rapprochement par nom trop permissif | La légende dit quel nom l'a trouvé. « Revérifier les rapprochements » (Réglages) repasse les rapprochements par ressemblance sous les règles du jour, retire ceux qu'elles refusent et réexamine les entités dans la foulée. Une passe ordinaire ne le fera jamais : elle saute ce qui a déjà un visage |
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
