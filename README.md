# One Piece Explorer

Un graphe de connaissances **temporel, sourcé et anti-spoiler** construit à
partir des chapitres de One Piece que vous importez vous-même.

Chaque fait sait à quel chapitre le lecteur a pu l'apprendre. Déplacez le
curseur de chapitre et l'œuvre se réduit à ce que vous saviez alors : un alias
reste un alias tant que le vrai nom n'est pas révélé, deux silhouettes restent
deux nœuds tant que le chapitre qui les identifie n'est pas atteint, une
croyance réfutée reste visible dans le passé où elle était tenue pour vraie.

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
pnpm test:e2e          # Playwright, parcours complet
pnpm typecheck && pnpm lint
```

`pnpm db:push:test` crée la base si elle n'existe pas. pgvector n'étant pas
packagé pour PostgreSQL local, les embeddings basculent automatiquement sur
`real[]` avec cosinus en SQL ; sur Supabase, pgvector est utilisé.

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
- [Critères d'acceptation](docs/acceptance-criteria.md) — dont les huit
  scénarios anti-spoiler bloquants
- [Ontologie v0](src/domains/knowledge/ontology.ts) — types de nœuds et
  prédicats, source de vérité du seed
