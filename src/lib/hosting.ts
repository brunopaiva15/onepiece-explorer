/**
 * Are we actually running on Vercel — or does a file merely say so?
 *
 * `vercel env pull` writes the platform's own system variables into the file it
 * produces, `VERCEL="1"` among them. So a developer who follows the documented
 * way to get their configuration ends up with a local `.env.local` that claims
 * to be a deployment. Nothing announces it, and three behaviours change at once:
 * the upload ceiling drops to the platform's 4.5 MB request limit, the job queue
 * switches to send-only, and error messages start telling you to redeploy.
 *
 * Every one of those is wrong on a laptop, and the local machine is precisely
 * where this project does its importing — the ceiling it would impose is the
 * ceiling the whole local setup exists to escape.
 *
 * The discriminator is `NODE_ENV`. A deployment always runs a production build;
 * `next dev` and `tsx` never do. A local production build is the one case this
 * gets wrong, and it is not a case anyone imports chapters through.
 */
export function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1' && process.env.NODE_ENV === 'production'
}

/**
 * Does the environment claim Vercel while plainly not being it?
 *
 * Worth saying out loud in the diagnostics rather than silently correcting: the
 * lines are in the file, they will be read by the next tool that looks for them,
 * and deleting them is a five-second fix.
 */
export function vercelFlagLooksPulled(): boolean {
  return process.env.VERCEL === '1' && process.env.NODE_ENV !== 'production'
}

/**
 * `CLAUDE_AGENT_RUNTIME=inline`, posée là où elle ne peut pas être suivie.
 *
 * Vit ici plutôt qu'à côté de `agentRuntime`, parce que trois surfaces ont
 * besoin de la même réponse et qu'une seule d'entre elles peut importer du code
 * marqué `server-only` : le choix de la dorsale, `pnpm doctor`, et la page
 * /admin/etat — dont la règle est de ne dépendre de rien de ce qu'elle
 * diagnostique.
 *
 * Le prédicat est là pour être *dit*, pas seulement appliqué. Le silence est ce
 * qui a coûté cher : la variable reste dans les réglages du projet, elle sera
 * relue par le prochain qui les ouvre, et rien n'indique qu'elle ne fait plus
 * rien. La corriger sans le dire, c'est promettre le même après-midi à quelqu'un
 * d'autre.
 */
export function inlineRuntimeIgnored(): boolean {
  return process.env.CLAUDE_AGENT_RUNTIME?.trim() === 'inline' && isVercelRuntime()
}
