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
