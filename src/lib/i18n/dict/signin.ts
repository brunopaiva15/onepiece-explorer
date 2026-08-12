import type { Locale } from '../index.ts'

/**
 * The sign-in page and form. French defines the shape; `typeof fr` makes
 * English cover every key.
 *
 * `authErrors` holds the human-readable replacements for Supabase's raw
 * error strings — the matching (which raw message maps to which key) stays in
 * the form; only the wording lives here, per language. English keeps closer to
 * Supabase's own phrasing but still explains the situation the way the French
 * does.
 */
const fr = {
  metadataTitle: 'Connexion',
  heading: 'Entrer dans le journal',
  intro: 'Cette bibliothèque est privée. Connectez-vous pour y accéder.',

  notConfiguredTitle: "Supabase n'est pas configuré",
  // Segments of one sentence, interleaved with <code> spans in the page.
  setupCopy: 'Copiez',
  setupTo: 'vers',
  setupFill: 'et renseignez',
  setupAnd: 'et',
  setupThen: ', puis appliquez le schéma avec',

  footerNote:
    "Aucun chapitre n'est téléchargé ni récupéré en ligne : vous importez des fichiers que vous possédez déjà.",

  emailLabel: 'Adresse e-mail',
  passwordLabel: 'Mot de passe',
  signupNotice: 'Compte créé. Confirmez votre adresse e-mail, puis revenez vous connecter.',
  submitSignIn: 'Se connecter',
  submitSignUp: 'Créer le compte',
  toggleToSignUp: 'Pas encore de compte ? En créer un',
  toggleToSignIn: 'Déjà un compte ? Se connecter',

  authErrors: {
    invalidCredentials: 'Adresse e-mail ou mot de passe incorrect.',
    emailNotConfirmed: 'Adresse e-mail non confirmée. Vérifiez votre boîte de réception.',
    alreadyRegistered: 'Un compte existe déjà avec cette adresse. Connectez-vous.',
    passwordTooShort: 'Le mot de passe doit contenir au moins 6 caractères.',
    rateLimited: 'Trop de tentatives. Patientez une minute avant de réessayer.',
    network: 'Connexion à Supabase impossible. Vérifiez NEXT_PUBLIC_SUPABASE_URL.',
    invalidApiKey:
      "La clé NEXT_PUBLIC_SUPABASE_ANON_KEY n'est pas acceptée par ce projet. " +
      "Trois causes : elle vient d'un autre projet que NEXT_PUBLIC_SUPABASE_URL, " +
      'elle a été tronquée au collage (une clé JWT fait plus de 200 caractères, ' +
      'sur une seule ligne), ou les clés héritées sont désactivées dans Supabase ' +
      '— auquel cas prenez la clé « publishable ». Rien à voir avec votre mot de passe.',
  },
}

const en: typeof fr = {
  metadataTitle: 'Sign in',
  heading: 'Enter the journal',
  intro: 'This library is private. Sign in to access it.',

  notConfiguredTitle: 'Supabase is not configured',
  setupCopy: 'Copy',
  setupTo: 'to',
  setupFill: 'and set',
  setupAnd: 'and',
  setupThen: ', then apply the schema with',

  footerNote:
    'No chapter is downloaded or fetched online: you import files you already own.',

  emailLabel: 'Email address',
  passwordLabel: 'Password',
  signupNotice: 'Account created. Confirm your email address, then come back to sign in.',
  submitSignIn: 'Sign in',
  submitSignUp: 'Create the account',
  toggleToSignUp: 'No account yet? Create one',
  toggleToSignIn: 'Already have an account? Sign in',

  authErrors: {
    invalidCredentials: 'Incorrect email address or password.',
    emailNotConfirmed: 'Email address not confirmed. Check your inbox.',
    alreadyRegistered: 'An account already exists with this address. Sign in instead.',
    passwordTooShort: 'The password must be at least 6 characters long.',
    rateLimited: 'Too many attempts. Wait a minute before trying again.',
    network: 'Could not reach Supabase. Check NEXT_PUBLIC_SUPABASE_URL.',
    invalidApiKey:
      'This project does not accept the NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Three possible causes: it comes from a different project than NEXT_PUBLIC_SUPABASE_URL, ' +
      'it was truncated when pasted (a JWT key is over 200 characters, ' +
      'on a single line), or legacy keys are disabled in Supabase ' +
      '— in which case use the "publishable" key. Nothing to do with your password.',
  },
}

export const signin = { fr, en } satisfies Record<Locale, typeof fr>
