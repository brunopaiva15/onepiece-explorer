# ADR 0008 — Un chapitre est un texte que vous écrivez

**Statut :** accepté · **Date :** 2026-08-12 · **Remplace en partie :** rien, mais
réduit la portée des ADR 0003 et 0006.

## Contexte

Le pipeline lisait des fichiers. Un chapitre importé, c'était : découpe en cases
par vision par ordinateur, transcription du texte, puis un appel de modèle
multimodal **par case** pour décrire ce qui est dessiné, et enfin une extraction
lisant ces descriptions pour proposer des faits. Environ cent vingt appels de
modèle porteurs d'image pour un chapitre, trois à cinq minutes par tranche
d'extraction, quatre dollars pour le premier chapitre réel — avec plus de mille
chapitres à traiter.

Ce n'était pas un problème de réglage. Le coût et la latence venaient de la forme
même du pipeline : il dépensait la majeure partie de son budget à reconstruire du
texte à partir de dessins, pour qu'une seconde étape lise ce texte. Les pixels
n'ont jamais été l'objet. Ce dont l'extraction a besoin, c'est de prose.

## Décision

**Un chapitre est un récit détaillé que l'utilisateur écrit ou colle**, découpé en
passages. Ces passages sont la source citable : toute proposition doit en citer un
mot pour mot.

L'ancien chemin fichier reste dans le dépôt et reste exécutable pour les chapitres
déjà importés ainsi (`chapters.source_kind = 'pages'`), mais il n'est plus proposé
à l'import. Le pipeline d'un chapitre écrit compte quatre étapes au lieu de neuf :
extraction, rapprochement d'entités, détection de contradictions, indexation.

## Ce qui ne change pas

**La frontière.** Un résumé est écrit pour le chapitre N, ses passages portent
`chapter_number = N`, et les mêmes politiques de sécurité au niveau ligne
s'appliquent (ADR 0001).

**L'ancrage des preuves, et il se renforce.** Le déclencheur
`app.validate_evidence_anchor` exigeait déjà qu'un extrait apparaisse dans le bloc
qu'il cite. Cette comparaison portait sur de l'OCR — une approximation avec ses
propres erreurs, donc une tolérance dans laquelle une fabrication pouvait se
glisser. Elle porte maintenant sur exactement les caractères que vous avez tapés.
Un extrait apparaît dans votre texte ou n'y apparaît pas (ADR 0003).

**La connaissance zéro externe.** Le modèle ne voit que le texte fourni et les
entités déjà visibles à ce chapitre.

**L'IA propose, l'humain décide.** Rien n'entre dans le graphe sans revue.

## Ce que cela coûte

Il n'y a plus de case source derrière un fait. « Montre-moi la case qui le
prouve » devient « montre-moi la phrase qui le dit ». Pour un graphe de
connaissances c'est le même travail — la preuve a toujours été les mots — mais
c'est un vrai changement de ce à quoi ressemble une citation, et il faut le dire
plutôt que le découvrir.

La qualité du graphe devient la qualité de ce que vous écrivez. C'est assumé : le
pipeline ne peut extraire que ce que la source affirme, et c'était déjà vrai des
pages. La différence est que la source est maintenant sous votre contrôle direct,
donc corrigible.

## Deux conséquences qui ont demandé leur propre mécanisme

### La langue de la source n'est pas celle du graphe

Les meilleurs résumés de chapitre disponibles sont souvent en anglais ; le graphe
se lit en français. Ces deux faits se rencontrent dans un seul champ.

Tout ce que le modèle **rédige** est en français : libellés, résumés d'événement,
questions de mystère, justifications. Le seul champ **recopié**, `excerpt`, reste
dans la langue de la source — c'est une citation, vérifiée caractère par
caractère, et la traduire la ferait ne correspondre à rien. Le modèle serait puni
d'avoir obéi à la règle de langue.

Les noms propres sont exclus de la traduction : « Straw Hat Pirates » devient
« Équipage du Chapeau de Paille », mais Luffy reste Luffy — un nom francisé
silencieusement ne correspondrait plus au même personnage au chapitre suivant.

La détection de langue **avoue son incertitude**. Elle compte les mots outils, et
quand l'écart est trop faible ou l'échantillon trop pauvre, l'import refuse et
pose la question. Se tromper ici est invisible ensuite : les extraits s'ancrent
quand même, le graphe se construit quand même, et la seule trace est une colonne
que personne ne lit.

### Le nom français doit être décidé une fois, pas à chaque chapitre

Traduire ou garder un nom est une **convention tenue par le lecteur**, pas un fait
du texte. Un modèle sommé de trancher tranche — différemment à chaque appel :
« Équipage du Roux » au chapitre 1, « Pirates aux Cheveux Rouges » au chapitre 4,
donc deux entités là où il y a une personne. Cet échec échappe à l'ancrage des
preuves, puisque les deux libellés sont honnêtement tirés de la source.

Le modèle déclare donc `naming_confident: false` quand il hésite. L'entité part en
revue explicite avec un champ modifiable, votre réponse est enregistrée dans
`glossary_terms`, et tous les chapitres suivants de l'œuvre reçoivent ce
vocabulaire dans leur prompt. La question est posée une fois par terme, pas une
fois par chapitre.

Le glossaire est **borné par le chapitre où vous avez répondu**, exactement comme
l'existence d'une entité (migration 0009) : apprendre qu'un terme se dit X est
souvent la révélation elle-même, et servir le glossaire complet à une extraction
du chapitre 3 ferait fuiter le futur dans le prompt.

## Alternatives écartées

**Garder les images et réduire les coûts** — modèle moins cher pour la
description, appels concurrents, lots à moitié prix. Cela aurait divisé la facture
par deux ou trois. Le problème est d'un ordre de grandeur : quatre dollars le
chapitre, mille chapitres, il fallait un facteur cinquante, pas trois.

**Faire produire le résumé par un modèle depuis les pages.** C'est le pipeline
qu'on retire, avec une étape de plus.

**Récupérer les résumés automatiquement en ligne.** Exclu par la contrainte du
projet : aucun scraping, rien de téléchargé automatiquement. L'utilisateur colle
ce qu'il a lu.

**Une table `passages` distincte.** Les passages sont stockés dans `text_blocks`,
dont `page_id` et `bbox` deviennent nullables (migration 0015). Une nouvelle table
aurait imposé une seconde cible à `evidence`, et donc de modifier l'ancrage, le
déclencheur, le centre de revue, la fiche d'entité et le réancrage — pour un
modèle de données identique à celui qui existait déjà.
