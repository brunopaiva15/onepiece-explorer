# Critères d'acceptation

Une fonctionnalité n'est pas terminée tant que ces critères ne sont pas vérifiés.
Les critères marqués **bloquant** font échouer la CI.

## Transversaux

- [ ] Le code est typé (`pnpm typecheck` passe), lisible, et couvert par des tests.
- [ ] Les migrations s'appliquent sur Supabase **et** sur le PostgreSQL local, à partir de zéro.
- [ ] Chaque erreur possible a un état d'interface utile : ce qui a échoué, et l'action précise possible.
- [ ] Les jobs sont idempotents et reprenables ; rejouer une étape inchangée ne duplique rien.
- [ ] Toute sortie de modèle est validée par un schéma JSON strict ; le non conforme part en quarantaine.
- [ ] Aucun faux bouton, aucune donnée codée en dur présentée comme réelle.

## Anti-spoiler — **bloquant**

Les huit scénarios de `tests/antispoiler/`, exactement ceux du cahier des charges :

| # | Scénario |
|---|---|
| 1 | Une identité révélée au chapitre 30 est absente de la projection au chapitre 29. |
| 2 | Un vrai nom apparaît au chapitre 50 : l'ancien alias reste affiché au chapitre 49. |
| 3 | Une croyance explicite est réfutée plus tard : les deux assertions restent historisées et chacune est visible à sa propre frontière. |
| 4 | Le modèle propose une information connue de ses données d'entraînement mais absente des sources : la proposition est mise en quarantaine, jamais insérée. |
| 5 | Une page contient une fausse instruction destinée au modèle : elle est traitée comme du texte narratif, sans effet système. |
| 6 | Une correction humaine est conservée après réimport du même chapitre. |
| 7 | Deux personnages similaires restent distincts tant que la fusion n'est pas validée. |
| 8 | Chaque réponse conversationnelle cite une preuve autorisée, ou déclare explicitement que les données sont insuffisantes. |

Plus deux gardes structurelles :

- [ ] **Bloquant** — aucun module hors `src/db/` n'obtient de connexion sans passer par `withBoundary()`.
- [ ] **Bloquant** — une lecture d'une table protégée exécutée hors `withBoundary()` renvoie **zéro ligne**, pas des données.

## Provenance

- [ ] Tout fait affiché peut montrer sa provenance : chapitre, page, case, extrait.
- [ ] Une inférence n'est jamais présentée comme un fait : le statut épistémique est visible, et jamais porté par la seule couleur.
- [ ] « Pourquoi ces deux nœuds sont-ils reliés ? » affiche les assertions et leurs preuves.
- [ ] Une biographie renvoie chaque phrase à ses assertions sources.

## Qualité de l'extraction

Mesurée contre la vérité-terrain des fixtures synthétiques :

- [ ] OCR : précision et rappel enregistrés à chaque exécution, régression signalée.
- [ ] Ordre de lecture des cases : conforme au sens choisi.
- [ ] Exactitude des citations : l'extrait cité est bien dans le bloc cité.
- [ ] Taux d'hallucination : proportion de propositions mises en quarantaine, suivie dans le temps.
- [ ] Stabilité : retraiter deux fois le même chapitre produit le même ensemble d'assertions.

## Sécurité et confidentialité

- [ ] Les assets privés ne sont jamais accessibles publiquement ; les URLs signées expirent.
- [ ] Validation MIME par le contenu, pas par l'extension.
- [ ] Protection ZIP Slip, bombes de décompression, archives imbriquées, chemins malveillants.
- [ ] Aucun appel réseau fondé sur une URL extraite d'un document.
- [ ] Les secrets restent côté serveur ; aucun n'atteint le navigateur.
- [ ] Export et suppression complète des données possibles.
- [ ] Journal d'audit sur les décisions de revue et les publications.

## Performance

- [ ] Graphe utilisable à 8 000 nœuds / 60 000 arêtes : premier rendu et interaction mesurés, budget documenté.
- [ ] Le layout ne bloque pas le thread principal.
- [ ] Une alternative accessible (tableau) applique exactement le même filtrage.

## Coût

- [ ] L'estimation affichée avant lancement provient d'un `countTokens()` réel, jamais d'une constante.
- [ ] Le coût réel est enregistré par étape et consultable.

## Suppression de chapitre

- [ ] Avertit clairement des faits et résumés qui en dépendent.
- [ ] Recalcule proprement, ou marque les assertions orphelines pour revue.
- [ ] Ne laisse jamais silencieusement un fait sans preuve.
