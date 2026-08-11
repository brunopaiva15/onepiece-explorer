# Importer depuis votre machine, de A à Z

Vercel sert la lecture ; votre machine importe. Ce document est la marche à
suivre complète, sans rien supposer d'installé.

**Pourquoi cette séparation.** Un chapitre arrive dans le corps d'une requête
HTTP, et une plate-forme serverless plafonne ce corps — 4,5 Mo sur Vercel, sans
réglage possible. Un chapitre fait dix à cent fois cela. Le worker du pipeline,
lui, n'existe pas non plus sur Vercel : c'est un processus long, et il n'y a que
des fonctions. Les deux se règlent au même endroit, votre machine, qui écrit dans
**la même base Supabase**. Vous importez d'un côté, vous consultez de l'autre.

---

## 1. Les prérequis

**Node 22 ou plus.** Vérifiez :

```bash
node --version
```

S'il manque ou s'il est trop vieux : [nodejs.org](https://nodejs.org) (choisissez
la version LTS), ou via [nvm](https://github.com/nvm-sh/nvm) sur macOS/Linux.

**pnpm 10 ou plus.** Node 22 l'inclut via corepack :

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm --version
```

**Vous n'avez pas besoin de PostgreSQL en local.** Vous vous connectez à votre
base Supabase. PostgreSQL local ne sert qu'à la suite de tests, et vous n'en avez
pas besoin pour importer.

---

## 2. Récupérer le projet

```bash
git clone https://github.com/brunopaiva15/onepiece-explorer.git
cd onepiece-explorer
pnpm install
```

L'installation compile `sharp` et `@napi-rs/canvas`, qui téléchargent des binaires
précompilés. Comptez une minute.

---

## 3. La configuration

Vos variables sont déjà dans Vercel. Le plus simple est de les récupérer telles
quelles plutôt que de les recopier à la main :

```bash
pnpm dlx vercel login
pnpm dlx vercel link          # choisissez le projet onepiece-explorer
pnpm dlx vercel env pull .env.local --environment=production
```

Le fichier obtenu est ignoré par Git.

### `--environment=production` n'est pas décoratif

Sans ce drapeau, `vercel env pull` récupère l'environnement **Development**. Une
variable que vous n'avez attachée qu'à Production et Preview n'en descend pas :
le fichier paraît complet, et rien ne signale les absentes. C'est la cause la
plus fréquente de ceci, au premier `pnpm dev` :

```
Configuration incomplète :
  • NEXT_PUBLIC_SUPABASE_URL : Invalid input: expected string, received undefined
  • NEXT_PUBLIC_SUPABASE_ANON_KEY : Invalid input: expected string, received undefined
```

Deux corrections, au choix : cocher **Development** sur ces variables dans Vercel
puis refaire le pull, ou ouvrir `.env.local` et coller les deux valeurs à la
main — c'est plus court que de comprendre pourquoi elles manquaient.

**À la main**, donc : `cp .env.example .env.local` (`copy` sous cmd.exe), puis
remplissez les six valeurs. Les deux premières se lisent aussi bien dans Supabase
→ Project Settings → API (« Project URL » et la clé `anon` / `public`) que dans
Vercel → Settings → Environment Variables ; les autres, seulement dans Vercel.

La colonne de droite dit **à quoi sert** la variable ; ce n'est pas sa valeur. Les
deux formes attendues :

```
NEXT_PUBLIC_SUPABASE_URL=https://abcdefgh.supabase.co
DIRECT_URL=postgresql://postgres.abcdefgh:MOT_DE_PASSE@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
```

| Variable | Ce qu'elle sert |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | authentification |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | authentification |
| `SUPABASE_SERVICE_ROLE_KEY` | **indispensable** : c'est elle qui écrit dans le bucket |
| `DATABASE_URL` | lectures (pooler, port 6543) |
| `DIRECT_URL` | migrations, worker, pipeline (pooler mode session, port 5432) |
| `ANTHROPIC_API_KEY` | extraction |

### Une ligne à vérifier avant tout le reste

```
STORAGE_DRIVER=supabase
```

C'est la valeur par défaut de `.env.example`, mais vérifiez-la. Si elle vaut
`local`, vos pages seront écrites sur le disque de votre machine : l'import
paraîtra réussir, et Vercel affichera des fiches dont les images sont
introuvables. Rien ne vous le dira sur le moment.

### Vérifiez — avant `pnpm dev`, pas après

```bash
pnpm doctor
```

Il lit le même `.env.local` que l'application et nomme chaque variable absente,
ligne par ligne. Lancé maintenant, il vous épargne la découverte du problème dans
le navigateur.

Tout doit être vert : les variables, les deux connexions, les migrations, et
surtout **« Bucket "chapters" — existe et est privé »**. `doctor` n'affiche jamais
une valeur, seulement si elle est là et ce que l'autre bout a répondu.

---

## 4. Lancer les deux processus

Deux terminaux, dans le dossier du projet.

```bash
# terminal 1 — l'interface
pnpm dev
```

```bash
# terminal 2 — le worker du pipeline
pnpm worker
```

L'interface est sur http://localhost:3000, connectée à votre vraie base : vous y
retrouvez le compte créé sur Vercel.

**Le worker est indispensable.** Sans lui, un chapitre importé reste
indéfiniment « en attente d'un worker » — ce n'est pas un bug, c'est un processus
qui n'a pas été lancé. Laissez-le tourner pendant tout l'import, coupez-le après.

---

## 5. Importer un chapitre

1. http://localhost:3000/import
2. Numéro du chapitre. **Il compte** : c'est lui qui date tout ce que le chapitre
   apprend, et donc ce qui restera caché derrière le curseur.
3. Le fichier — PDF, CBZ/ZIP, ou les images de pages. Un PDF **avec couche
   texte** évite l'OCR : l'extraction est alors exacte et gratuite.
4. Sens de lecture : droite-vers-gauche par défaut.
5. Importer. Les pages apparaissent tout de suite, en aperçu réordonnable.

Aucune limite de 4,5 Mo ici : le plafond de transport local vaut
`MAX_UPLOAD_BYTES`, soit 500 Mo par défaut.

**Mais le stockage a le sien.** Le plan gratuit Supabase refuse tout fichier de
plus de **50 Mo**, et ce plafond n'est pas relevable sur ce plan. L'application
acceptera le fichier, puis le stockage le rejettera — l'erreur remonte, mais
elle arrive tard. Si un chapitre dépasse 50 Mo, réexportez-le à une résolution
plus basse, ou passez les pages en WebP avant d'importer.

**Et surveillez le total** : 1 Go de stockage sur le plan gratuit, soit de
l'ordre de 25 à 60 chapitres selon la résolution. C'est le vrai plafond de ce
projet, bien avant la question de l'envoi. `/reglages` montre ce que chaque
chapitre occupe, et la suppression d'un chapitre efface réellement les octets.

---

## 6. Traiter, relire, publier

**Lancez le traitement** depuis la fiche du chapitre. Suivez-le sur `/runs/[id]`,
étape par étape, avec la durée et le coût réel de chacune.

Coût attendu : **0,08 à 0,45 $ par chapitre**. L'estimation affichée avant
lancement vient d'un comptage de tokens réel, pas d'une constante.

**Rien n'entre dans le graphe sans votre accord.** Un traitement réussi laisse le
chapitre « à revoir », jamais « publié ». Allez sur `/review/[runId]` : chaque
proposition arrive avec la case source, l'extrait, la description, les entités
candidates et leurs raisons. Raccourcis : `a` accepter, `r` rejeter, `f`
fusionner, `s` séparer, `d` reporter.

Puis publiez le delta. À partir de là, c'est visible dans le graphe — sur
localhost comme sur Vercel, c'est la même base.

---

## 7. Les images

Une fois quelques chapitres publiés :

```bash
pnpm images:catalogue    # une fois par mois : ~1 000 illustrations, trois API gratuites
pnpm images:enrich       # rapproche vos entités, télécharge, range dans le bucket
```

Ou le bouton dans `/reglages`, qui montre d'abord la couverture par type.

Le stockage suit `STORAGE_DRIVER`. Avec `supabase`, les portraits vont dans votre
bucket privé et Vercel les sert. Une entité sans image reste parfaitement
lisible.

---

## 8. Ouvrir la lecture au public, si vous voulez

Sur `/reglages`, section « Lecture publique », copiez votre identifiant de
bibliothèque. Dans Vercel, ajoutez :

```
PUBLIC_LIBRARY_OWNER_ID=<cet identifiant>
```

Redéployez. N'importe qui pourra alors explorer le graphe, la chronologie, les
fiches et la recherche, avec son propre curseur de chapitre. **Pas les images de
pages** : elles restent derrière l'authentification, et un visiteur ne voit que
la référence de la case et l'extrait cité.

Et pensez à couper les inscriptions dans Supabase (Authentication → Sign In /
Providers → « Allow new users to sign up »), sinon n'importe qui peut créer un
compte.

---

## Ce qui va probablement coincer

| Symptôme | Cause | Correction |
|---|---|---|
| `Configuration incomplète : NEXT_PUBLIC_… undefined` | `.env.local` absent du dossier du projet, ou pull de l'environnement Development | `pnpm doctor` nomme les manquantes ; voir §3 |
| `Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL` | `NEXT_PUBLIC_SUPABASE_URL` contient autre chose qu'une URL | Attendu : `https://<ref>.supabase.co`, dans Supabase → Project Settings → API |
| `getaddrinfo ENOTFOUND base` au lancement du worker | `DIRECT_URL` n'est pas une chaîne de connexion. Le pilote PostgreSQL accepte n'importe quel texte et lit le mot « base » d'une phrase française comme un nom d'hôte — d'où ce message, qui ne nomme pas la variable | `pnpm doctor` affiche l'hôte réellement extrait de chaque connexion |
| « en attente d'un worker », indéfiniment | `pnpm worker` n'est pas lancé | Lancez-le, terminal 2 |
| L'import réussit, Vercel n'affiche pas les images | `STORAGE_DRIVER=local` | Mettez `supabase` et réimportez |
| `SUPABASE_SERVICE_ROLE_KEY est requis` | La clé manque dans `.env.local` | Copiez-la depuis Vercel |
| `DIRECT_URL n'est pas configuré` | Idem, pour le worker | Le pooler en mode session, port 5432 |
| Le traitement échoue sur une page | Page corrompue ou trop grande | `/runs/[id]` nomme l'étape et la raison ; les limites sont dans `.env.local` |
| Beaucoup de propositions en quarantaine | Voir `/reglages` | Une raison qui domine = problème systématique, pas une mauvaise passe |

Windows : les commandes de ce document sont portables. Seuls `pnpm db:push:test`
et `pnpm demo` posent une variable en ligne et échoueraient sous PowerShell — vous
n'en avez pas besoin ici.
