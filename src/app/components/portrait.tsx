import type { DisplayImage } from '@/domains/images/index.ts'

/**
 * An entity's portrait, and the honesty that has to travel with it.
 *
 * These pictures come from three public fan catalogues, matched to an entity by
 * name. A name match is a guess — a very good one at 1.0, a reasonable one at
 * 0.7 — and a face shown without saying so would read as something the pipeline
 * established from your pages. It did not. Nothing in this application is
 * allowed to look more certain than it is, and a portrait is the easiest thing
 * in an interface to believe.
 *
 * So the caption names the source and the label that found it. It is small, and
 * it is not optional.
 *
 * Plain `<img>` rather than `next/image`: the URL is signed and expires, and
 * the optimiser would cache a copy under a stable public path — which is the
 * one thing private assets must never have.
 */

export function Portrait({
  image,
  label,
  size = 'large',
}: {
  image: DisplayImage | null
  label: string
  size?: 'large' | 'small' | 'inline'
}) {
  if (!image) return null

  /*
   * A face inside a sentence, sitting on the text's own baseline.
   *
   * The caption cannot travel with this one — there is nowhere to put it in the
   * middle of a line — so it is only ever used *next to the name it belongs
   * to*, which is the honesty the caption normally provides: the reader can see
   * what the picture claims to be and judge it. It is decorative to a screen
   * reader, because the name is right there in the text.
   */
  if (size === 'inline') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image.thumbUrl}
        alt=""
        loading="lazy"
        width={24}
        height={24}
        className="vignette"
      />
    )
  }

  if (size === 'small') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image.thumbUrl}
        alt=""
        loading="lazy"
        width={40}
        height={40}
        className="h-10 w-10 shrink-0 rounded-sm border border-line object-cover"
      />
    )
  }

  return (
    <figure className="shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url}
        alt={`Illustration de ${label}`}
        loading="lazy"
        className="w-40 rounded-sm border border-line bg-surface-raised object-contain"
      />
      <figcaption className="mt-1.5 w-40 text-xs leading-snug text-muted">
        <a
          href={image.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-dotted hover:text-secondary"
        >
          {image.attribution}
        </a>{' '}
        · rapprochée depuis «&nbsp;{image.matchedLabel}&nbsp;»
        {image.matchScore < 1 && ` (${matchWording(image.matchMethod)})`}
      </figcaption>
    </figure>
  )
}

/**
 * How the match was made, in words rather than a number.
 *
 * "0.7" tells the reader nothing about whether to trust the face. "nom partiel"
 * tells them exactly what to check.
 */
function matchWording(method: string): string {
  switch (method) {
    case 'exact':
      return 'nom identique'
    case 'tokens':
      return 'mêmes mots, autre ordre'
    case 'subset':
      return 'nom partiel'
    case 'trigram':
      return 'orthographe proche'
    default:
      return method
  }
}
