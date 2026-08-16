'use client'

import { useCallback, useRef, useState } from 'react'
import { collectThread, storyAsText, type StoryWindow } from './transcript.ts'

/**
 * The whole thread, in the clipboard. The owner's button.
 *
 * Shown only to a signed-in owner, and not because the text is secret — every
 * bead in it is on a page anyone may read. It is that this is a workshop tool:
 * the copy exists to be pasted into a document and proofread, and offering a
 * visitor a button that pulls a thousand chapters through their connection
 * would be offering them a chore.
 *
 * **It reads the same windows the scroll reads.** `/api/histoire`, from the
 * chapter the thread starts at, following `nextCursor` to the end — so the
 * copy is bounded by the reader's boundary exactly like the page is, and there
 * is no second path to the beads that could disagree with the first. It is
 * also why this pages rather than asking a route for everything at once: a
 * library of a thousand chapters is a thousand boundaried reads, and a single
 * request holding all of them open is a request that dies at a platform's
 * timeout with nothing to show. Paging says which chapter it is on and stops
 * where it fails.
 *
 * **The clipboard is allowed to refuse.** It does, routinely: over plain HTTP,
 * in a browser that ties the write to the click that started it, in a page that
 * lost focus during the fetch. The text exists by then, so refusing to hand it
 * over would be losing work that is already done — the failure falls back to a
 * textarea holding the copy, selected, and the reader presses the shortcut they
 * were going to press anyway.
 */

interface Props {
  /** The chapter the thread starts at — where the copy starts too. */
  start: number
  /** The reader's boundary, echoed to the API like the scroll echoes it. */
  boundary: number
  /** Where the thread stops. Written into the copy's header. */
  lastChapter: number
}

type State =
  | { name: 'repos' }
  /** Reading, and which chapter it has got to. */
  | { name: 'lecture'; chapter: number }
  | { name: 'copie'; chapters: number }
  /** The clipboard refused. The text is here instead. */
  | { name: 'secours'; text: string }
  | { name: 'echec' }

export function CopyStory({ start, boundary, lastChapter }: Props) {
  const [state, setState] = useState<State>({ name: 'repos' })
  /** A second click while the first is still reading would double the work. */
  const busy = useRef(false)

  const copy = useCallback(async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setState({ name: 'lecture', chapter: start })

    try {
      const beats = await collectThread(
        start,
        async (from): Promise<StoryWindow> => {
          const response = await fetch(
            `/api/histoire?depuis=${from}&ch=${boundary}`,
          )
          if (!response.ok) throw new Error(String(response.status))
          return (await response.json()) as StoryWindow
        },
        (chapter) => setState({ name: 'lecture', chapter }),
      )

      const text = storyAsText(beats, { start, lastChapter })
      const chapters = new Set(beats.map((beat) => beat.chapter)).size

      try {
        if (!navigator.clipboard) throw new Error('pas de presse-papier')
        await navigator.clipboard.writeText(text)
        setState({ name: 'copie', chapters })
      } catch {
        setState({ name: 'secours', text })
      }
    } catch {
      setState({ name: 'echec' })
    } finally {
      busy.current = false
    }
  }, [boundary, lastChapter, start])

  const reading = state.name === 'lecture'

  return (
    <>
      <div className="fil-copie">
        <button
          type="button"
          className="bouton fil-copie-bouton"
          onClick={() => void copy()}
          disabled={reading}
        >
          <Feuilles />
          {reading ? 'Lecture…' : 'Copier le fil'}
        </button>

        {/* One line, and it is always the truth about the last attempt: what
            is being read, what was copied, or what failed. */}
        <p className="fil-copie-etat" role="status" aria-live="polite">
          {message(state, start, lastChapter)}
        </p>
      </div>

      {state.name === 'secours' && (
        <div className="fil-copie-secours">
          <p className="text-secondary">
            Le navigateur a refusé l’accès au presse-papier. Le fil est là,
            déjà sélectionné&nbsp;: copiez-le avec le raccourci habituel.
          </p>
          <textarea
            readOnly
            rows={8}
            value={state.text}
            className="fil-copie-zone"
            ref={(node) => {
              node?.focus()
              node?.select()
            }}
          />
        </div>
      )}
    </>
  )
}

/** What the status line says, per state. */
function message(state: State, start: number, lastChapter: number): string {
  switch (state.name) {
    case 'repos':
      return `Tout le fil, du chapitre ${start} au chapitre ${lastChapter}, en texte brut.`
    case 'lecture':
      return `Lecture du chapitre ${state.chapter}…`
    case 'copie':
      return `Copié : ${state.chapters} chapitre${state.chapters > 1 ? 's' : ''}, jusqu’au chapitre ${lastChapter}.`
    case 'secours':
      return 'Le presse-papier a refusé.'
    case 'echec':
      return 'Le fil n’a pas pu être lu en entier. Rien n’a été copié : réessayez.'
  }
}

/** Two sheets, one behind the other. « 📋 » is an emoji on half the phones. */
function Feuilles() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path
        d="M1.5 1.5 H7.5 V7.5 H1.5 Z M4.5 4.5 H10.5 V10.5 H4.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  )
}
