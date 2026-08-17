import type { Sql } from 'postgres'

/**
 * Qui le rattrapage a le droit d'interroger.
 *
 * Ici plutôt que dans le script, et pour la même raison que la carte : c'est la
 * moitié qui coûte de l'argent quand elle est fausse. Le premier passage sur une
 * bibliothèque de 140 chapitres a proposé **141 figures** dont « Chapeau de
 * paille », « Base de la Marine », « Statue de Morgan », « Clé de la cage » et
 * « Prime d'Alvida » — des objets et des lieux dont le libellé *est* le nom, sans
 * rien à révéler, chacun payé un appel pour se faire répondre non.
 *
 * La faute était de prendre « sans `true_name` » pour « sans nom ». La
 * publication ne range en `true_name` que ce que le modèle a marqué ainsi, et
 * pour un lieu ou un objet il met presque toujours autre chose : l'absence de
 * `true_name` mesure donc la nomenclature du modèle, pas l'ignorance du lecteur.
 *
 * Une révélation d'identité porte sur **quelqu'un ou une organisation** — le
 * majordome qui est Kuro, la silhouette qui est Wapol, l'équipage qui est celui
 * du Chat Noir. C'est la seule restriction ajoutée, et ce qu'elle laisse de côté
 * est réel et rare : le fruit que Baggy a mangé finit par avoir un nom, et ce
 * cas-là reste au geste manuel de la fiche, qui existe pour ce que les règles ne
 * rattrapent pas.
 *
 * Pas de `server-only` et pas de `withBoundary` : la fonction reçoit son client,
 * ce qui la rend exerçable depuis un test comme depuis un script. Le curseur du
 * lecteur ne la protège de rien et n'a rien à y protéger — elle lit la
 * bibliothèque entière pour proposer des cartes, et la date écrite plus tard est
 * celle du chapitre qui révèle.
 */

export interface UnnamedFigureRow {
  entity_id: string
  work_id: string
  user_id: string
  label: string
  first_seen_chapter: number
}

/**
 * Les figures encore sans nom, les plus anciennes d'abord.
 *
 * Quatre conditions au-delà du type, et trois d'entre elles sont ce qui rend une
 * seconde exécution gratuite : pas de vrai nom, pas déjà rejointe par une
 * identité, pas déjà portée par une carte en attente. La quatrième — qu'elle
 * porte au moins un libellé — écarte un nœud qu'aucune ligne ne nomme, dont il
 * n'y aurait rien à dire au modèle.
 */
export async function unnamedFigures(sql: Sql): Promise<UnnamedFigureRow[]> {
  return sql<UnnamedFigureRow[]>`
    SELECT en.id AS entity_id, en.work_id, en.user_id, en.first_seen_chapter,
           (SELECT l.label FROM entity_labels l
             WHERE l.entity_id = en.id
             ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
             LIMIT 1) AS label
      FROM entities en
     WHERE en.review_status = 'accepted'
       AND en.node_type IN ('character', 'group')
       AND NOT EXISTS (SELECT 1 FROM entity_labels l
                        WHERE l.entity_id = en.id AND l.kind = 'true_name')
       AND NOT EXISTS (SELECT 1 FROM assertions a
                        WHERE a.predicate = 'same_as'
                          AND a.review_status = 'accepted'
                          AND (a.subject_entity_id = en.id OR a.object_entity_id = en.id))
       AND NOT EXISTS (SELECT 1 FROM review_items ri
                        WHERE ri.status = 'proposed'
                          AND ri.category = 'assertion'
                          AND ri.payload->>'subject' = en.id::text)
       AND EXISTS (SELECT 1 FROM entity_labels l WHERE l.entity_id = en.id)
     ORDER BY en.first_seen_chapter, en.id
  `
}
