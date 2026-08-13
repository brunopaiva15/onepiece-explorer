import Link from 'next/link'
import { epistemicColour, epistemicLabel } from '@/domains/knowledge/epistemic-label.ts'
import type { ProfileEntry, ProfileSection } from '@/domains/knowledge/profile.ts'

/**
 * The fiche, laid out the way its subject is read.
 *
 * Each panel is one question — who is in this crew, what is on this island,
 * what opened this mystery — and each line is one answer: a rôle, a name, the
 * chapter you could first know it. It is a *summary*, and the summary is
 * allowed to be short only because the record it summarises is on the same
 * page, one click below, with every panel and every excerpt still attached.
 *
 * Which is why the chapter on the right is a link rather than a number. It
 * carries `detail=1`, so the record opens as the page renders and the anchor
 * lands — no client-side script, and no dependence on browsers agreeing to
 * expand a closed `<details>` for a fragment they were handed.
 *
 * The colour on the left edge is the claim's status. It is never the only
 * carrier: anything that is not a plain affirmation prints its word too, and
 * only « affirmé » — the ordinary case, and the one that would drown the
 * others in badges — stays silent.
 */
export function EntityProfile({
  sections,
  entityId,
  boundary,
}: {
  sections: ProfileSection[]
  entityId: string
  boundary: number
}) {
  if (sections.length === 0) return null

  return (
    <div className="mt-8 grid items-start gap-4 md:grid-cols-2">
      {sections.map((section) => (
        <section key={section.key} className="panneau">
          <h2 className="panneau-titre">
            <span>{section.title}</span>
            <span className="chiffre text-xl">{section.entries.length}</span>
          </h2>
          <ul className="divide-y divide-line">
            {section.entries.map((entry) => (
              <ProfileLine
                key={entry.key}
                entry={entry}
                entityId={entityId}
                boundary={boundary}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function ProfileLine({
  entry,
  entityId,
  boundary,
}: {
  entry: ProfileEntry
  entityId: string
  boundary: number
}) {
  return (
    <li
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-4 py-1.5 pl-2.5 pr-3"
      style={{ borderLeftColor: epistemicColour(entry.epistemicStatus) }}
    >
      <span className="cartouche">{entry.role}</span>

      {entry.otherType && (
        /* The graph's own colour for this type, so a group is the same red
           here as it is in the picture. Decorative: the rôle above and the
           heading already say what this is. */
        <span
          aria-hidden
          className="inline-block size-2.5 self-center border border-ink"
          style={{
            background: `var(--type-${entry.otherType}, var(--surface-sunken))`,
          }}
        />
      )}

      {entry.otherId ? (
        <Link
          href={`/entite/${entry.otherId}?ch=${boundary}`}
          className="font-medium text-primary hover:underline"
        >
          {entry.otherLabel ?? 'entité sans nom révélé'}
        </Link>
      ) : (
        <span className="font-medium text-primary">{entry.literalValue}</span>
      )}

      {entry.epistemicStatus !== 'explicit' && (
        <span
          className="text-[0.7rem]"
          style={{ color: epistemicColour(entry.epistemicStatus) }}
        >
          {epistemicLabel(entry.epistemicStatus)}
        </span>
      )}

      {entry.knowledgeUntilChapter !== null && (
        /* Inside the window where this was believed and is not yet refuted.
           Saying so is the point of the two-axis model — a wiki would have
           deleted the line. */
        <span className="text-[0.7rem] text-[var(--epi-hypothetical)]">
          démenti ch. {entry.knowledgeUntilChapter}
        </span>
      )}

      {entry.locked && (
        <span
          className="text-[0.7rem] text-muted"
          title="Corrigé par vous : jamais remplacé par une nouvelle extraction"
        >
          votre correction
        </span>
      )}

      <Link
        href={`/entite/${entityId}?ch=${boundary}&detail=1#fait-${entry.assertionIds[0]}`}
        className="ml-auto font-mono text-xs text-muted decoration-dotted hover:underline"
        title={
          entry.evidenceCount === 0
            ? 'Voir ce fait dans le relevé'
            : entry.evidenceCount === 1
              ? 'Voir ce fait et sa preuve'
              : `Voir ce fait et ses ${entry.evidenceCount} preuves`
        }
      >
        ch. {entry.knowledgeFromChapter}
      </Link>
    </li>
  )
}
