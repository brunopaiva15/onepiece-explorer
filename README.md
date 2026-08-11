# One Piece Explorer

Un seul grand graphe de connaissances **interconnecté et sourcé**, construit à
partir des chapitres de One Piece que vous importez vous-même : personnages,
groupes, lieux, objets, événements, promesses, mystères. C'est là qu'on trouve
les liens auxquels on n'avait pas pensé — un chemin entre deux personnages, une
récurrence, un recoupement à trois cents chapitres d'écart.

Chaque fait sait aussi **à quel chapitre vous avez pu l'apprendre**. Par défaut
vous voyez tout ce que vous avez importé ; le curseur sert à revenir en arrière
quand vous le voulez. Là, le graphe redevient ce que vous saviez alors : un
alias reste un alias tant que le vrai nom n'est pas révélé, deux silhouettes
restent deux nœuds tant que le chapitre qui les identifie n'est pas atteint,
une croyance réfutée reste visible dans le passé où elle était tenue pour vraie.

C'est ce qui rend le grand graphe sûr à construire pendant qu'on lit encore :
rien ne vous gâche la lecture, et rien n'est perdu non plus.

> **Outil privé.** L'application ne télécharge rien, ne récupère aucun scan en
> ligne, ne contourne aucune protection et ne publie rien. Vous importez des
> fichiers que vous possédez déjà ; ils restent accessibles à vous seul,
> derrière une authentification, servis uniquement par URL signée à durée
> courte. Le dépôt ne contient aucune page de manga : les fixtures de test sont
> des planches synthétiques générées par script.

---

## Ce qui rend ce projet différent

**La frontière de chapitre est appliquée par la base de données, pas par le
code applicatif.** Une politique PostgreSQL de sécurité au niveau ligne filtre
chaque lecture selon `app.boundary_chapter`, posé par transaction. Un endpoint
oublié, une jointure trop large ou une requête écrite dans six mois ne *peuvent
pas* laisser fuir un fait futur — la base refuse. Voir
[ADR 0001](docs/adr/0001-chapter-boundary-in-the-database.md).

**Rien n'est écrasé.** Les connaissances sont des assertions en ajout seul,
avec deux axes temporels distincts : quand le fait est vrai dans l'histoire, et
quand le lecteur peut le savoir. Une correction insère une ligne et renseigne
`superseded_by`. Un déclencheur refuse toute autre modification.
Voir [ADR 0002](docs/adr/0002-append-only-assertions.md).

**Le modèle ne peut pas répondre de mémoire.** Un modèle multimodal connaît
déjà One Piece et compléterait volontiers les trous. Toute proposition doit
citer un bloc de texte ou une case de la liste fournie, et l'extrait cité doit
réellement s'y trouver — vérifié dans le code, puis à nouveau par un
déclencheur. Ce qui échoue part en quarantaine, visible dans le centre de
revue. Voir [ADR 0003](docs/adr/0003-evidence-anchoring.md).

---

## Installation

**Prérequis** : Node 22+, pnpm 10+, et un projet [Supabase](https://supabase.com)
(gratuit suffit).

```bash
pnpm install
cp .env.example .env.local   # puis renseignez les valeurs, voir ci-dessous
pnpm db:push                 # migrations, rôles, politiques RLS, ontologie
pnpm doctor                  # vérifie que tout répond vraiment
```

`pnpm doctor` se connecte réellement à chaque service et rapporte ce qu'il
obtient : les deux connexions Postgres, l'état des migrations, les rôles SQL,
la présence de pgvector, la confidentialité du bucket, et la joignabilité de
l'API Anthropic (par un comptage de tokens, gratuit). Deux contrôles y valident
une promesse plutôt qu'une connexion : que la RLS bloque effectivement une
lecture sans frontière, et que le bucket n'est pas public. Ces deux-là échouent
en silence autrement — l'application marcherait parfaitement tout en fuyant.
Aucun secret n'est affiché.

### Variables à renseigner

| Variable | Où la trouver |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | idem. Sert **uniquement** à l'authentification et aux URLs signées |
| `SUPABASE_SERVICE_ROLE_KEY` | idem. Serveur uniquement, jamais exposé au navigateur |
| `DATABASE_URL` | Connection string **Transaction pooler** (port 6543) |
| `DIRECT_URL` | Connection string **Direct** (port 5432) |
| `ANTHROPIC_API_KEY` | [console Anthropic](https://console.anthropic.com) |

Les deux connexions ne sont pas interchangeables. Les lectures applicatives
passent par le pooler en mode transaction (`prepare: false` obligatoire) ; les
migrations, le worker et le pipeline exigent la connexion directe.

### Bucket de stockage

Créez un bucket **privé** nommé `chapters` dans Supabase Storage. S'il est
public, les pages importées deviennent accessibles à quiconque devine une URL.

### Sans clé Anthropic

L'application démarre et le parcours reste exécutable : le pipeline bascule sur
un fournisseur synthétique et l'affiche par une bannière explicite. L'extraction
montrée est alors générée, pas réelle. C'est un mode de repli, pas le mode
nominal.

---

## Lancement

```bash
pnpm dev      # interface   → http://localhost:3000
pnpm worker   # worker du pipeline (processus séparé)
```

**Le worker est indispensable.** L'import lui-même est synchrone : vous voyez
les pages tout de suite. Mais le traitement — découpage en cases, transcription,
extraction — passe par une file de jobs, et sans worker un chapitre reste
indéfiniment « en attente d'un worker » sur `/runs/[id]`. Ce n'est pas un bug de
l'application, c'est un processus qui n'a pas été lancé.

Le parcours import → file → pipeline se vérifie d'un coup, sans navigateur :

```bash
TEST_DB=1 pnpm smoke:worker
```

### Pourquoi deux processus

Le découpage en cases décode les pages en pleine résolution, et les étapes de
modèle tiendront des lots longs. Faire cela dans un gestionnaire de requête
lierait le traitement d'un chapitre à la durée de vie d'une connexion HTTP :
fermer l'onglet abandonnerait le travail à moitié fait.

Le worker tourne sur la **connexion directe** (port 5432), pas sur le pooler :
pg-boss maintient des connexions d'écoute longues et gère son propre schéma,
deux choses incompatibles avec un pooler en mode transaction.

---

## Le parcours, de l'import au graphe

```
/import          →  /runs/[id]        →  /review/[runId]   →  graphe
importer            suivre le pipeline    trancher            interroger
                    étape par étape       chaque proposition
```

**Rien n'entre dans le graphe sans votre accord.** Un traitement réussi laisse
le chapitre en état « à revoir », jamais « publié » : le pipeline produit des
propositions, pas du canon. C'est une contrainte du code, pas une convention —
un test vérifie que la table des assertions est encore vide après un traitement
réussi.

### Les deux garde-fous mécaniques

**Ancrage des preuves.** Toute proposition doit citer une référence de case ou
de bloc issue d'une liste blanche, et son extrait doit se retrouver dans le
texte réel de ce bloc. Sinon : quarantaine, jamais la file de revue. C'est ce
qui empêche le modèle de répondre depuis ce qu'il sait déjà de One Piece plutôt
que depuis vos pages. Ce que ce garde-fou arrête n'est pas un fait faux, c'est
un fait *plausible* : bien formé, citant une case d'apparence réelle, décrivant
quelque chose que vous n'avez pas encore lu.

**Texte du document = donnée.** Une page peut contenir une pancarte qui
ressemble à une consigne. Le texte des pages passe dans une enveloppe
`<untrusted_document_text>`, les appels d'extraction se font **sans outils**,
aucune URL trouvée dans un document n'est suivie — et de toute façon une
affirmation produite par une telle consigne n'aurait rien à quoi s'ancrer.

### La quarantaine est un diagnostic, pas une poubelle

Sa répartition se lit : trente rejets `unknown_ref` signalent un découpage en
cases qui a mal tourné ; trente `excerpt_not_in_source` signalent une
transcription trop dégradée pour que quoi que ce soit s'ancre. Les éléments en
quarantaine ne sont **jamais** proposables — les mettre devant quelqu'un en fin
de session de revue, avec une étiquette plausible et une citation d'apparence
réelle, est exactement la façon dont un fait fabriqué entre dans un graphe.

### Sans clé Anthropic

Le parcours complet reste exécutable. Le fournisseur synthétique ne réorganise
que ce qu'on lui donne : les noms propres de la couche texte du PDF, cités au
bloc dont ils viennent, en `related_to` et en `hypothetical` — la force exacte
de ce qu'il peut affirmer. Il refuse de lire une image plutôt que d'inventer un
dialogue, et répond « données insuffisantes » plutôt que de composer une prose
qu'il ne peut pas soutenir. L'interface le dit.

---

## Chercher, et poser des questions

```
/recherche   plein texte · orthographe approchante · voisinage · sens
/ask         une question, une réponse sourcée — ou « données insuffisantes »
```

### La recherche dit comment elle a trouvé

Quatre modes, fusionnés par rang réciproque plutôt que par score : `ts_rank_cd`
et la similarité trigramme sont des grandeurs différentes sur des échelles
différentes, et les normaliser en un seul nombre produirait un classement qui a
l'air fondé et qui est arbitraire. Chaque résultat porte le mode qui l'a trouvé,
parce que « correspond à vos mots exacts » et « ressemble à ce que vous avez
tapé » ne méritent pas la même confiance.

Un mode qui n'a pas pu tourner le **dit**. La différence entre « votre
bibliothèque n'a pas la réponse » et « une façon de chercher n'a jamais eu lieu »
est toute la différence entre un résultat vide fiable et un résultat vide
trompeur.

### Le chemin entre deux entités

C'est ce qu'un graphe interconnecté permet et qu'un wiki ne permet pas : la
chaîne de relations la plus courte entre deux personnages, telle que vous la
connaissez à ce chapitre. Reculez le curseur et vous voyez à partir de quand le
lien existait.

Chaque relation compte pour un pas, sans pondération. La confiance serait le
choix tentant et il serait faux : une relation peu sûre n'est pas une connexion
plus *longue*, elle est moins certaine — confondre les deux ferait
silencieusement contourner au lecteur exactement les liens qu'il devrait
regarder.

### L'assistant ne peut pas répondre de mémoire

Trois mécanismes, dans cet ordre :

1. **Le contexte est filtré avant d'être assemblé.** Récupérer puis filtrer est
   l'ordre inverse et c'est ainsi que ces systèmes fuient. Ici tout passe par
   `withBoundary` : le modèle ne voit jamais une ligne qu'il pourrait divulguer.
2. **Sans contexte, aucun appel.** Demander à un modèle de répondre à partir de
   rien, c'est lui demander de répondre depuis son entraînement — et il le fera,
   avec aisance, sur des chapitres que vous n'avez pas ouverts.
3. **Chaque citation est vérifiée** contre ce qui était réellement dans le
   contexte, par identifiant. Une citation qui ne correspond à rien est retirée
   et signalée ; une réponse dont toutes les citations tombent devient « données
   insuffisantes », jamais une affirmation nue.

L'extrait affiché vient du contexte, pas de la réponse du modèle : citer un vrai
identifiant en paraphrasant la citation est l'échec le plus subtil ici, et le
lecteur doit voir ce que la page dit vraiment.

```bash
TEST_DB=1 pnpm eval:assistant
```

Trois scores : citations inventées, franchissements de frontière, réponses
malhonnêtes. Les questions du jeu incluent « Qui est le père de Luffy ? » — le
piège de connaissance externe le plus direct qui soit.

### Recherche sémantique

Anthropic n'expose pas d'endpoint d'embeddings. La recherche plein texte,
approchante et par graphe fonctionne sans aucune clé ni dépendance
supplémentaire ; la couche sémantique est enfichable derrière `VectorStore`.
Sans fournisseur, le magasin vectoriel **déclare** son indisponibilité au lieu
de renvoyer une liste vide — une liste vide affirmerait que rien ne correspond,
ce qui est une affirmation sur votre bibliothèque, et elle serait fausse.

---

## Tests

La suite tourne sur un PostgreSQL local et sur des réponses de modèle
enregistrées — hermétique, gratuite, déterministe. C'est ce qui permet aux
tests anti-spoiler d'être **bloquants** plutôt que « parfois rouges ».

```bash
# une seule fois : base de test locale
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test"
pnpm db:push:test

pnpm test              # unitaires + intégration
pnpm test:antispoiler  # les scénarios bloquants
pnpm test:perf         # 8 000 nœuds / 60 000 arêtes
pnpm typecheck && pnpm lint
```

`pnpm db:push:test` crée la base si elle n'existe pas. pgvector n'étant pas
packagé pour PostgreSQL local, les embeddings basculent automatiquement sur
`real[]` avec cosinus en SQL ; sur Supabase, pgvector est utilisé.

Le parcours complet, sans navigateur et sans clé API :

```bash
pnpm demo
```

Trois chapitres synthétiques : import, pipeline, publication, puis le même
graphe lu depuis trois endroits de l'histoire. Si la frontière casse, les trois
lectures deviennent identiques et cela se voit dans la sortie. Le script vise
toujours la base de test — il importe des chapitres inventés et accepte tout
sans revue, ce qu'on ne veut pas voir arriver à sa vraie bibliothèque.

Il n'y a **pas** de tests de navigateur. Le parcours est couvert par `pnpm demo`
et par les tests d'intégration ; un harnais Playwright exigerait un projet
Supabase joignable, ce qui retirerait à la suite l'hermétisme qui permet aux
tests anti-spoiler d'être bloquants.

---

## Structure

```
drizzle/            migrations SQL écrites à la main (rôles, RLS, déclencheurs)
docs/adr/           décisions d'architecture et leurs raisons
src/db/             client, schéma Drizzle, et withBoundary()
src/domains/        ingestion · documents · knowledge · resolution · review
                    temporal · search · assistant · viz · auth · storage · ai
src/worker/         worker pg-boss
tests/antispoiler/  les scénarios bloquants
scripts/            migrations, fixtures, démonstration
```

### La règle à ne pas contourner

Toute lecture de connaissance passe par `withBoundary()`. Rien d'autre
n'obtient de connexion à la base. Une règle ESLint le vérifie, et
`tests/antispoiler/boundary-guards.test.ts` le vérifie aussi — parce qu'une
règle de lint peut être désactivée en ligne, et que ce mécanisme est la
garantie centrale du produit.

```ts
const graphe = await withBoundary(
  { userId, boundaryChapter: 42 },
  (db) => db.select().from(assertions),
)
// Ce qui a été révélé au chapitre 43 n'est pas dans le résultat.
// Pas filtré ensuite : absent.
```

---

## Documentation

- [Décisions d'architecture](docs/adr/) — pourquoi la frontière est en base,
  pourquoi les assertions sont immuables, pourquoi l'ontologie est une donnée,
  comment le coût IA est maîtrisé
- [Exploitation](docs/operations.md) — déployer, surveiller, sauvegarder,
  purger, et le tableau des pannes courantes avec leur diagnostic
- [Critères d'acceptation](docs/acceptance-criteria.md) — dont les huit
  scénarios anti-spoiler bloquants, et ce qui reste explicitement non fait
- [Ontologie v0](src/domains/knowledge/ontology.ts) — types de nœuds et
  prédicats, source de vérité du seed
