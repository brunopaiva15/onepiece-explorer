# ADR 0014 — Une seconde lecture avant la vôtre, sur la page du chapitre

**Statut :** accepté · **Date :** 2026-08-17 · **Prolonge :** les ADR 0009 et 0013.

## Contexte

L'ADR 0013 a donné au lot le droit de se dérouler seul : la passe automatique
(`domains/review/auto.ts`) accepte ce dont aucun nom ne dépend, garde ce qui
demande quelqu'un, et le chapitre s'ouvre quand il ne reste rien. Elle nomme
elle-même son coût — « ce qui entre dans le graphe sans lecture humaine » — et
elle nomme ce qu'elle laisse : un nom dont le modèle n'était pas sûr, une carte
sous le seuil de confiance, un rapprochement, une contradiction, une relation
que l'ontologie refuse.

Ce reste est la facture réelle. Sur un lot de cinquante chapitres, « ce qui
demande quelqu'un » redevient une soirée de clics, et la chaîne s'arrête à
chaque chapitre qui en porte un. Pire : la plupart de ces questions se
répondent en allant lire la page du chapitre sur le One Piece Fandom — ce que
l'ADR 0009 a déjà autorisé la machine à faire, et que le relecteur refaisait à
la main, onglet par onglet.

Deux modèles interviennent déjà et ni l'un ni l'autre ne peut répondre. Celui
qui extrait n'a que le texte cité du chapitre, ce qui est exactement sa
discipline (ADR 0003) : il ne sait pas comment le wiki français écrit un nom, et
il ne doit pas le deviner. La passe automatique, elle, ne lit rien du tout —
c'est une règle sur des catégories et un score.

## Décision

**Un troisième modèle relit les propositions, la page du chapitre en main.**
Après l'extraction et avant la publication automatique, l'étape `arbitrate`
soumet chaque proposition encore en file à un modèle, avec **la page entière du
chapitre sur le Fandom, en anglais et en français**. Il rend un verdict par
carte : accepter, rejeter, ou laisser au lecteur.

**« Je ne sais pas » est une réponse de premier rang.** C'est la demande telle
qu'elle a été formulée — « si vraiment elle a du mal et elle n'y arrive pas,
alors me laisser décider » — et c'est aussi la seule façon d'automatiser sans
payer l'automatisation en réponses fausses. Le schéma n'exige ni citation ni
motif pour une abstention, et le prompt dit qu'en cas de doute c'est la bonne
réponse : une carte laissée coûte un clic, une carte tranchée à tort entre dans
le graphe avec l'air d'avoir été vérifiée.

**Un verdict ne vaut que sa citation, vérifiée mot pour mot.** Accepter ou
rejeter demande une phrase de la page, recopiée caractère pour caractère, et
`domains/review/arbitration.ts` la cherche dans le texte réellement récupéré.
Introuvable, ou trop courte pour ne pas s'y trouver par hasard : le verdict est
annulé et la carte repart au lecteur, avec l'avis affiché. C'est le contrôle que
l'ancrage applique à l'extraction (ADR 0003) et que le balayage des identités
applique à ses citations, refait ici pour la même raison — un modèle à qui l'on
tend une page en citera parfois une phrase qui n'y est pas, dans le bon
registre, avec les bons noms.

**La page est une référence, jamais une source.** Un verdict change le *statut*
d'une proposition et ne touche ni sa preuve, ni ses bouts, ni son libellé : une
carte acceptée porte toujours l'extrait du texte importé auquel l'ancrage l'avait
attachée. Rien de ce que la page contient n'entre dans le graphe, et rien de ce
qu'elle dit ne peut être cité par une assertion. C'est ce qui permet de montrer
une page du web à un modèle sans rouvrir ce que l'ADR 0003 a fermé.

**Un rapprochement et une contradiction ne sont jamais décidés ici.** L'avis
s'affiche sur la carte, avec sa citation ; le clic reste au lecteur. C'est
exactement la ligne que la passe automatique trace déjà — « personne d'autre ne
décide d'une identité » — et l'arbitrage ne la desserre pas : il rend la question
plus rapide à trancher en posant la phrase du wiki à côté d'elle.

**Une question de nom se tranche sur la graphie.** Accepter la forme française
proposée exige qu'elle figure telle quelle dans la page. « Foosha » et
« Fuchsia » sont deux entités, et c'est précisément ainsi qu'on en fabrique deux
— la réponse acceptée est écrite au glossaire et servira à tous les chapitres
suivants, donc elle vaut la sévérité.

**Une entité qu'une autre carte nomme n'est pas rejetée.** Le rejet est une
décision, pas une mise en attente : la relation qui la vise resterait publiable
et échouerait à la publication sur un bout qui n'existe pas, dans une passe que
personne ne regarde.

**Avant `auto_publish`, et l'ordre fait tenir l'ensemble.** La publication
automatique ouvre le chapitre quand il ne reste rien et enchaîne le suivant du
lot (ADR 0013). Placé après elle, l'arbitrage aurait tranché des cartes sur un
chapitre déjà refermé et le lot serait resté arrêté sur des questions auxquelles
il venait de répondre.

**Les décisions passent par `publishDecisions`, comme celles d'un humain.**
C'est la porte unique du graphe : atomique, idempotente, datée par révélation et
journalisée. Une passe automatique qui écrirait à côté serait une seconde porte,
avec ses propres bogues et sans son journal. Le motif et la citation partent
dans le commentaire de la décision, donc l'audit reste lisible sans rouvrir une
page du wiki qui aura changé.

**Ce que le modèle a répondu est écrit sur la carte** (`review_items.arbitration`,
migration 0031), qu'il ait été appliqué ou non. Sur une carte qui remonte au
lecteur, c'est l'avis et sa phrase — c'est-à-dire l'essentiel de l'enquête qu'on
cherche à lui épargner. Sur une carte décidée sans lui, c'est la réponse à
« qu'est-ce qui est entré sans moi, et sur quelle phrase », qui est la question
qu'on se pose trois mois plus tard.

**L'étape refuse de tourner sans un modèle qui lise vraiment.** Les modes
synthétique et rejoué répondent en comparant des mots ; ils accepteraient des
propositions avec l'aplomb d'une vraie lecture. Et la raison qui décide :
l'étape va chercher une page sur le réseau, ce qu'une suite de tests hermétique
ne fait pas. Ignorée dans ces modes, elle ne change rien à ce que le reste du
pipeline produit — les huit scénarios anti-spoiler restent bloquants et
inchangés.

## Ce que cela coûte

**Un appel de modèle par chapitre, et une requête au wiki par langue.** Sur mille
chapitres, ce n'est pas rien. La page est mise en préfixe caché et les cartes
partent par quarante, donc un chapitre dense paye la page une fois ; l'étape est
sur le palier d'extraction plutôt que sur celui d'escalade, pour le temps
d'horloge autant que pour l'argent — une invocation est tuée à cinq minutes.

**Des propositions décidées sans vous, sur une phrase de wiki.** C'est le coût
principal et il prolonge celui que l'ADR 0013 a déjà accepté, avec une
différence en votre faveur : la passe automatique accepte sur un score, celle-ci
n'accepte que si une phrase précise le dit. Rien n'est destructif, le centre de
revue sait rouvrir ce qui a été rejeté, et la fiche de l'entité montre ce qui a
été écrit.

**Le wiki peut se tromper, ou parler d'autre chose.** Une page est écrite par des
gens qui ont lu la fin : une anecdote y renvoie à un arc ultérieur, une liste de
personnages y nomme quelqu'un que le chapitre ne nomme pas. Le prompt le dit et
refuse explicitement d'accepter une révélation sur cette base ; c'est une
instruction, donc c'est plus faible qu'un mécanisme. La borne dure reste
ailleurs, et elle est intacte : la frontière date les faits par révélation, et
un verdict ne change pas la date d'une carte.

**Une relation au prédicat incompatible reste au lecteur.** L'arbitrage ne
corrige rien — il n'a que trois verdicts — et réparer un prédicat par une
décision « correct » marquerait la carte comme validée par un humain, ce qui
serait faux. La carte du centre de revue propose déjà les prédicats qui
conviennent ; c'est là que la question se règle.

## Alternatives écartées

**Ne soumettre que ce que la passe automatique garde.** C'eût été moins de
jetons et strictement moins utile : le second avis vaut aussi sur les cartes que
la passe automatique accepte les yeux fermés, et c'est précisément là qu'une
erreur d'extraction entre dans le graphe sans que personne la voie.

**Laisser le modèle corriger un libellé ou un prédicat.** Séduisant, et refusé :
la publication marque une décision « correct » comme validée par l'utilisateur,
verrouillée, attribuée à lui. Un modèle qui écrirait cela mentirait sur qui a
décidé, et c'est le genre de mensonge qui ne se découvre jamais.

**Faire décider les rapprochements par l'arbitrage.** C'est la version réellement
« sans arrêt », et elle annule la raison d'être de l'étape de résolution. Une
fusion fausse détruit la chronologie des révélations que tout ce système existe
pour tenir, et elle ne se rattrape par aucune étape ultérieure.

**Se contenter du résumé long, déjà récupéré à l'import.** C'est ce que le graphe
cite, et c'est le mauvais texte pour cet usage : la réponse à « comment le wiki
français écrit-il ce nom » est aussi souvent dans l'infobox, la liste des
personnages ou les notes que dans le récit. La page entière est demandée pour
cette raison, et elle n'est jamais citable — les deux choses vont ensemble.

**Une variable d'environnement pour allumer la passe.** Le fournisseur suffit :
un modèle qui lit vraiment arbitre, un modèle qui compare des mots s'abstient et
le dit. Un réglage de plus n'aurait ajouté qu'un état où l'étape ne tourne pas
sans que rien à l'écran ne l'explique.
