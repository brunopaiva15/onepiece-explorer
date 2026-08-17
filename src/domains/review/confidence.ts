/**
 * The confidence at which a proposal is accepted without anyone reading it.
 *
 * Three quarters, chosen by the owner of this library, and the number is the
 * whole policy: above it the model's own doubt is not worth a human's attention,
 * below it the card is the one thing a review is for. A queue of eighty-seven
 * proposals is not read card by card by anyone — it is skimmed — and a skim that
 * accepts everything is worse than an automatic pass, because it is an automatic
 * pass wearing a person's signature.
 *
 * What this is not is a way past the anti-spoiler rules. `requiresExplicitReview`
 * is checked first and separately everywhere this threshold is used: an identity
 * claim, a revelation, a death, a hidden affiliation, a mystery resolution or a
 * contradiction is never swept up, whatever number the model put on it. Those are
 * the claims whose premature acceptance rewrites what the reader knew at every
 * earlier chapter, and no score routes one past a human.
 *
 * No `server-only` here on purpose. The review board applies the same threshold
 * on screen as the automatic pass applies in the pipeline, and two constants
 * would drift — the reviewer would be shown one rule and the batch would run
 * another, with nothing on either screen to say which.
 */
export const AUTO_ACCEPT_CONFIDENCE = 0.75

/**
 * Whether the model was sure enough about this one to decide it alone.
 *
 * At the threshold exactly counts as sure: a proposal at 0.75 is on the side of
 * the line the number names, and a strict comparison would turn a round figure
 * into a trap for whoever tunes it.
 */
export function confidentEnough(
  confidence: number,
  threshold: number = AUTO_ACCEPT_CONFIDENCE,
): boolean {
  return confidence >= threshold
}
