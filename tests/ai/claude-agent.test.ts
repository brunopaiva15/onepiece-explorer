import { afterEach, describe, expect, it } from 'vitest'
import { agentPayload } from '@/domains/ai/claude-agent/payload.ts'
import {
  agentEnv,
  agentFailure,
  agentRuntime,
  ClaudeAgentError,
  creationRefusal,
  interpret,
  isAuthFailure,
  stderrTail,
  type AgentRequest,
  type RawAgentResult,
} from '@/domains/ai/claude-agent/runtime.ts'
import { ClaudeAgentProvider } from '@/domains/ai/claude-agent/provider.ts'
import { inlineRuntimeIgnored } from '@/lib/hosting.ts'
import { isProviderChoice, modelProvider, providerOptions, resetModelProvider } from '@/domains/ai/index.ts'
import { env, hasClaudeSubscription, remoteModelProvider, resetEnvCache } from '@/lib/env.ts'

/**
 * What is worth testing about running Claude on a subscription instead of a
 * metered key is not that it answers — that needs a real token and real money,
 * and the recorded cassettes already cover what the pipeline does with an
 * answer. It is the three things that would fail *silently*:
 *
 *   the request quietly asking something other than what the prompts say,
 *   a spent allowance quietly becoming a bill,
 *   the token quietly reaching somewhere it should not.
 *
 * Everything below is one of those three.
 */

const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
  resetModelProvider()
})

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const REQUEST: AgentRequest = {
  label: 'test',
  system: 'Vous êtes un extracteur.',
  content: [{ type: 'text', text: 'Chapitre 3.' }],
  model: 'claude-sonnet-5',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
}

function result(overrides: Partial<RawAgentResult> = {}): RawAgentResult {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    structured_output: { ok: true },
    usage: { input_tokens: 10, output_tokens: 4 },
    ...overrides,
  }
}

describe('the request Claude is given', () => {
  it('carries the project’s own system prompt, not an agent preset', () => {
    const { options } = agentPayload(REQUEST)
    // A string means "replace"; an object with `preset` would mean the coding
    // agent's prompt with ours appended — a second voice in the anti-spoiler
    // rules.
    expect(options.systemPrompt).toBe('Vous êtes un extracteur.')
    expect(typeof options.systemPrompt).toBe('string')
  })

  it('gives the model no tools and no MCP servers', () => {
    // The pages are an untrusted document. A model that could follow a URL
    // found in one would turn an upload into a server-side request forgery.
    const { options } = agentPayload(REQUEST)
    expect(options.tools).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.maxTurns).toBe(1)
  })

  it('reads no settings from disk, so this repository’s own CLAUDE.md cannot leak in', () => {
    /*
     * The SDK loads every settings source when this is omitted — user settings,
     * project settings, and CLAUDE.md / AGENTS.md from the working directory.
     * Instructions written for whoever edits this codebase have no business in
     * the context of a model being asked what happens in chapter 47.
     */
    expect(agentPayload(REQUEST).options.settingSources).toEqual([])
  })

  it('constrains the answer with a schema rather than hoping for JSON', () => {
    const { options } = agentPayload(REQUEST)
    expect(options.outputFormat.type).toBe('json_schema')
    expect(options.outputFormat.schema).toBe(REQUEST.schema)
  })

  it('passes the reasoning posture through untouched', () => {
    const bounded = agentPayload({ ...REQUEST, thinking: 'disabled', effort: 'medium' })
    expect(bounded.options.thinking).toEqual({ type: 'disabled' })
    expect(bounded.options.effort).toBe('medium')

    // Absent rather than defaulted: a tier with no opinion must send the
    // request it would have sent before any of this existed.
    const adaptive = agentPayload(REQUEST)
    expect(adaptive.options.thinking).toBeUndefined()
    expect(adaptive.options.effort).toBeUndefined()
  })

  it('sends images as content blocks', () => {
    const { message } = agentPayload({
      ...REQUEST,
      content: [
        { type: 'text', text: 'Image suivante : p1c1' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' },
        },
      ],
    })
    expect(message.role).toBe('user')
    expect(message.content).toHaveLength(2)
    expect(message.content[1]).toMatchObject({ type: 'image' })
  })
})

describe('the environment Claude runs in', () => {
  it('strips every variable that could put the call on a metered bill', () => {
    setEnv({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_AUTH_TOKEN: 'nope',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PATH: '/usr/bin',
    })

    const env = agentEnv('oat-token', '/tmp/home')

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    // Still a usable environment: the child needs a PATH to find a runtime.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-token')
    expect(env.HOME).toBe('/tmp/home')
  })

  it('runs inline off a deployment and in a sandbox on one', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: undefined, VERCEL: undefined, NODE_ENV: 'test' })
    expect(agentRuntime()).toBe('inline')

    setEnv({ VERCEL: '1', NODE_ENV: 'production' })
    expect(agentRuntime()).toBe('sandbox')

    // An explicit choice wins over the host, which is how the unused one gets
    // exercised before somebody needs it.
    setEnv({ CLAUDE_AGENT_RUNTIME: 'inline', VERCEL: undefined, NODE_ENV: 'test' })
    expect(agentRuntime()).toBe('inline')

    // Y compris la dorsale du déploiement sur une machine : c'est la seule façon
    // de savoir qu'elle marche encore avant d'en avoir besoin.
    setEnv({ CLAUDE_AGENT_RUNTIME: 'sandbox' })
    expect(agentRuntime()).toBe('sandbox')
  })

  /*
   * La demande qui ne peut mener qu'à la panne.
   *
   * Mesurée en production, et c'est la panne que ce dépôt s'est faite à lui-même :
   * `CLAUDE_AGENT_RUNTIME=inline` posée dans les réglages du projet Vercel — en
   * suivant le conseil que `creationRefusal` donnait alors — et les cent trente
   * et une questions du balayage échouant à l'identique sur « Native CLI binary
   * for linux-x64 not found », sans qu'aucune n'ait atteint un modèle. Trois
   * limites de plateforme s'y opposent et aucune ne se contourne ; honorer la
   * demande, c'est garantir le zéro.
   */
  it('refuses an inline runtime a deployment cannot possibly run', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: 'inline', VERCEL: '1', NODE_ENV: 'production' })

    expect(agentRuntime()).toBe('sandbox')
    // Refusée, et dite : la variable reste dans le tableau de bord, et une
    // correction muette promet le même après-midi à quelqu'un d'autre.
    expect(inlineRuntimeIgnored()).toBe(true)
  })

  it('leaves a laptop its inline runtime, pulled VERCEL lines and all', () => {
    // `vercel env pull` écrit VERCEL=1 dans .env.local. Le refus ci-dessus ne
    // doit pas se déclencher là : la machine peut lancer le CLI, elle l'a
    // installé, et c'est là que ce projet importe.
    setEnv({ CLAUDE_AGENT_RUNTIME: 'inline', VERCEL: '1', NODE_ENV: 'development' })

    expect(agentRuntime()).toBe('inline')
    expect(inlineRuntimeIgnored()).toBe(false)
  })
})

describe('a token Claude refuses', () => {
  /*
   * Measured against a real CLI, which is why this exists at all: an invalid
   * token comes back as a 401, the CLI retries a 401 ten times with backoff
   * like any transient error, and the call does not fail — it hangs until the
   * timeout fires and reports a timeout. Someone reading that goes and looks at
   * the network, at Claude's status page, at CLAUDE_AGENT_TIMEOUT_MS: at
   * everything except the variable that is wrong.
   */
  it('is recognised while it is still being retried', () => {
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 401 }),
    ).toBe(true)
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 403 }),
    ).toBe(true)
  })

  it('does not swallow the retries that backoff actually fixes', () => {
    // 429 and 5xx are what the retry loop is for; cutting those short would
    // turn a hiccup into a failed chapter.
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 429 }),
    ).toBe(false)
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 529 }),
    ).toBe(false)
    expect(isAuthFailure({ type: 'assistant' })).toBe(false)
  })

  /*
   * Et l'autre moitié : celle que le flux ne voit pas.
   *
   * `api_retry` suppose un CLI démarré, qui parle à l'API et se fait renvoyer.
   * Un jeton que le CLI rejette au démarrage ne produit aucun message : il sort
   * en code 1, le SDK lève « Claude Code process exited with code 1 », et
   * jusqu'ici les deux dorsales passaient `stderr: () => {}` — la seule phrase
   * qui disait pourquoi était jetée avant d'être lue. Ce qui remontait à
   * l'utilisateur était un code de sortie et une invitation à deviner.
   */
  it('is recognised from what the CLI said before dying', () => {
    const failure = agentFailure(
      'assistant',
      'Claude Code process exited with code 1',
      'Invalid API key · Please run /login',
    )

    expect(failure.kind).toBe('auth')
    expect(failure.message).toContain('claude setup-token')
  })

  it('does not read a revoked token into an ordinary crash', () => {
    // Diagnostiquer un jeton révoqué à tort envoie régénérer une clé valable
    // et cherche la panne partout sauf où elle est.
    const failure = agentFailure(
      'assistant',
      'Claude Code process exited with code 1',
      'Error: EACCES: permission denied, open /vercel/sandbox/req.json',
    )

    expect(failure.kind).toBe('sdk')
    expect(failure.message).toContain('EACCES')
  })

  it('keeps a spent allowance an allowance, wherever it is said', () => {
    const failure = agentFailure('extraction', 'exited with code 1', "You've hit your usage limit")

    expect(failure.kind).toBe('quota')
    expect(failure.message).toContain('Quota Claude Max atteint')
  })

  it('never writes the token into the message it hands back', () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret' })

    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'spawn failed: node cli.js --token sk-ant-oat-secret',
    )

    // Ce message finit dans une interface, un journal, et probablement un
    // rapport de bogue.
    expect(failure.message).not.toContain('sk-ant-oat-secret')
    expect(failure.message).toContain('***')
  })

  it('does not read a rejection into a trace that merely names the variable', () => {
    // « CLAUDE_CODE_OAUTH_TOKEN » se lit dans un environnement déballé, dans une
    // aide, dans une ligne de commande : partout sauf dans un refus.
    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'env: CLAUDE_CODE_OAUTH_TOKEN=… HOME=/vercel/sandbox\nEACCES: permission denied',
    )

    expect(failure.kind).toBe('sdk')
  })

  it('says so plainly when the CLI said nothing at all', () => {
    const failure = agentFailure('extraction', 'exited with code 1', '')

    expect(failure.kind).toBe('sdk')
    // Le silence lui-même est le diagnostic, et il est dit comme tel. Quelle
    // dorsale essayer ensuite dépend de celle qui tourne : voir plus bas.
    expect(failure.message).toContain('n’a rien écrit sur sa sortie d’erreur')
  })

  /*
   * Le silence n'est pas un verdict.
   *
   * Le SDK colle lui-même la fin de la sortie d'erreur au message « exited with
   * code N » : un message qui s'arrête au code dit donc que le processus n'a
   * rien écrit du tout, et un CLI qui refuse de démarrer, lui, explique
   * pourquoi. Ce qui reste — une machine reprise sous le processus, une durée de
   * vie atteinte — ne se reproduit pas sur un processus neuf. Ça se retente ;
   * ça ne se remonte pas à quelqu'un qui n'en peut rien faire.
   */
  it('marks a CLI that vanished without a word as worth one more try', () => {
    expect(agentFailure('extraction', 'exited with code 1', '').retryable).toBe(true)
  })

  it('does not retry a CLI that said why it failed', () => {
    // Un disque plein le sera tout autant la seconde fois.
    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'Error: ENOSPC: no space left on device',
    )

    expect(failure.retryable).toBe(false)
  })

  it('does not retry an answer, however it was worded', () => {
    // Un jeton révoqué et une allocation épuisée sont des réponses : les
    // rejouer rendrait la même, et le pas au-dessus décide quoi en faire.
    expect(agentFailure('extraction', 'code 1', 'Invalid API key').retryable).toBe(false)
    expect(agentFailure('extraction', 'code 1', "You've hit your usage limit").retryable).toBe(
      false,
    )
  })

  /*
   * Le conseil qui décrit l'état actuel.
   *
   * « Relancez avec CLAUDE_AGENT_RUNTIME=inline » était écrit sans regarder la
   * dorsale en cours, et se lisait donc mot pour mot dans l'échec d'un appel
   * inline : quelqu'un qui venait précisément de basculer dessus s'entendait
   * dire de basculer dessus, et doutait ensuite de tout le reste du message.
   */
  it('never advises the runtime it is already running on', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: 'inline', VERCEL: undefined, NODE_ENV: 'test' })
    expect(agentFailure('extraction', 'exited with code 1', '').message).not.toContain(
      'CLAUDE_AGENT_RUNTIME=inline',
    )

    setEnv({ CLAUDE_AGENT_RUNTIME: 'sandbox' })
    expect(agentFailure('extraction', 'exited with code 1', '').message).toContain(
      'CLAUDE_AGENT_RUNTIME=inline',
    )
  })

  /*
   * Ni celle qu'un déploiement ne peut pas suivre.
   *
   * « Relancez avec CLAUDE_AGENT_RUNTIME=inline » lu dans l'atelier en
   * production se comprend comme un réglage à poser en production, et c'est
   * précisément par là que la variable est arrivée dans les réglages du projet.
   * Le conseil reste bon sur une machine ; il doit dire laquelle.
   */
  it('says where inline is worth trying, when read from a deployment', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: 'sandbox', VERCEL: '1', NODE_ENV: 'production' })

    const message = agentFailure('extraction', 'exited with code 1', '').message

    expect(message).toContain('Sur une machine')
    expect(message).toContain('en déploiement cette variable est ignorée')
  })

  it('keeps the end of a long diagnostic, which is where the reason is', () => {
    const said = stderrTail(40)
    said.collect('bruit'.repeat(50))
    said.collect('la vraie raison')

    // Un CLI qui n'arrive pas à démarrer dit pourquoi en dernier.
    expect(said.text()).toContain('la vraie raison')
    expect(said.text().length).toBeLessThanOrEqual(40)
  })
})

/*
 * Claude Code absent de l'hôte qui devait le lancer.
 *
 * Mesuré une seconde fois sur le même balayage, après être passé en `inline` :
 * « Native CLI binary for linux-x64 not found ». Le CLI n'est plus du
 * JavaScript dans le paquet du SDK — c'est un exécutable natif de trois cents
 * mégaoctets dans un paquet optionnel propre à la plateforme, que le traceur
 * de build ne voyait pas. Et comme c'est le SDK qui lève, avant d'avoir lancé
 * quoi que ce soit, la sortie d'erreur était vide : lue comme « le processus a
 * disparu, retentez », puis suivie du conseil de basculer sur la dorsale déjà
 * en cours.
 */
describe('a host where Claude Code is not installed', () => {
  it('names the missing binary instead of blaming a vanished process', () => {
    const failure = agentFailure(
      'assistant',
      'Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk ' +
        'without --omit=optional, or set options.pathToClaudeCodeExecutable.',
      '',
    )

    expect(failure.kind).toBe('runtime')
    expect(failure.message).toContain('paquet optionnel propre à la plateforme')
    // Ce que le message disait avant, et qui désignait la mauvaise chose.
    expect(failure.message).not.toContain('il a disparu plutôt qu’échoué')
  })

  it('does not retry a binary that is not there', () => {
    // Un exécutable absent l'est tout autant une seconde plus tard, et le
    // silence de sa sortie d'erreur n'est pas un indice de machine perdue :
    // c'est le SDK qui a levé avant de lancer quoi que ce soit.
    const failure = agentFailure('extraction', 'Native CLI binary for linux-x64 not found.', '')

    expect(failure.retryable).toBe(false)
  })

  it('tells a laptop to reinstall', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: undefined, VERCEL: undefined, NODE_ENV: 'test' })

    expect(agentFailure('x', 'Native CLI binary for linux-x64 not found.', '').message).toContain(
      '--omit=optional',
    )
  })

  /*
   * Et le déploiement n'a plus à abandonner `inline` : il ne l'a jamais pris.
   *
   * Trois limites de plateforme s'y opposent, et elles se sont présentées une
   * par une : 250 Mo par fonction, puis 12 fonctions par déploiement en Hobby —
   * les vingt-cinq routes de ce dépôt ne tiennent qu'en étant fusionnées, ce
   * qu'un binaire de trois cent dix mégaoctets dans chacune rend impossible.
   * Expliquer cela à chaque appel, c'était l'expliquer cent trente et une fois
   * pour un balayage qui n'extrayait rien ; `agentRuntime` refuse la demande, et
   * ce qui reste à dire est que la variable est là et ne sert plus à rien.
   */
  it('names the stale variable rather than the runtime it no longer takes', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: 'inline', VERCEL: '1', NODE_ENV: 'production' })

    const deployed = agentFailure('x', 'Native CLI binary for linux-x64 not found.', '').message

    // La dorsale réelle, donc l'installation réelle : celle de la microVM.
    expect(deployed).toContain('registre npm')
    expect(deployed).toContain('est posée sur ce projet et ignorée')
    expect(deployed).toContain('Retirez-la des réglages du projet')
    // Ce que le message conseillait quand next.config.ts embarquait le binaire.
    // Il ne l'embarque plus, et pointer vers un mécanisme absent est pire que
    // de ne rien pointer.
    expect(deployed).not.toContain('outputFileTracingIncludes')
    expect(deployed).not.toContain('VERCEL_SUPPORT_LARGE_FUNCTIONS')
  })

  /*
   * Le même manque, deux installations opposées.
   *
   * En bac à sable le binaire vient du `npm install` de la microVM, qui ne lit
   * rien de ce que le build a tracé. Trier sur l'hôte seul répondait « tracez-le
   * dans le bundle » à une installation npm ratée à l'intérieur d'une machine
   * virtuelle : un conseil juste, appliqué à la mauvaise moitié du système.
   */
  it('does not send a sandbox to fix the build', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: 'sandbox', VERCEL: '1', NODE_ENV: 'production' })

    const message = agentFailure('x', 'Native CLI binary for linux-x64 not found.', '').message

    expect(message).toContain('registre npm')
    expect(message).not.toContain('outputFileTracingIncludes')
    expect(message).not.toContain('VERCEL_SUPPORT_LARGE_FUNCTIONS')
    // Et ne mentionne pas une variable que personne n'a posée.
    expect(message).not.toContain('est posée sur ce projet et ignorée')
  })

  it('recognises the older shape of the same absence', () => {
    // Le SDK a déjà dit ce manque autrement, et le dira encore autrement.
    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'Error: Cannot find module @anthropic-ai/claude-agent-sdk/cli.js',
    )

    expect(failure.kind).toBe('runtime')
    expect(failure.retryable).toBe(false)
  })
})

/*
 * Un hébergeur qui ne fournit pas la machine.
 *
 * Mesuré sur le balayage des mystères, qui s'est arrêté à trois questions sur
 * cent trente et une : « Status code 402 is not ok », et un message qui
 * répondait « vérifiez que Secure Backend Access (OIDC) est activé ». OIDC
 * était activé et parfaitement en ordre — un 402 est une facture, et la seule
 * chose que le refus avait à dire était dans son code, qui n'était pas lu.
 */
describe('a sandbox the platform will not create', () => {
  it('reads a spent Sandbox allowance as a bill and not as a login', () => {
    setEnv({ VERCEL: undefined, NODE_ENV: 'test' })
    const failure = creationRefusal(new Error('Status code 402 is not ok'))

    expect(failure.kind).toBe('billing')
    expect(failure.message).toContain('402')
    // Ce que la phrase ne doit surtout plus faire : envoyer relire une
    // configuration d'authentification qui n'a rien à se reprocher.
    expect(failure.message).not.toContain('Secure Backend Access')
    expect(failure.message).toContain('CLAUDE_AGENT_RUNTIME=inline')
  })

  /*
   * Et l'issue proposée doit exister sur l'hôte qui la lit.
   *
   * C'est le défaut qui a fabriqué la panne suivante. Ces messages finissaient
   * tous sur « CLAUDE_AGENT_RUNTIME=inline ne demande aucun bac à sable » — vrai
   * sur une machine, faux là où un 402 se lit presque toujours. Le conseil a été
   * suivi : la variable est partie dans les réglages du projet Vercel, et le
   * balayage suivant a échoué cent trente et une fois sur un binaire absent au
   * lieu de trois fois sur une facture. Il ne restait alors rien d'exact dans le
   * message qui avait raison sur le 402.
   */
  it('never offers a deployment the one runtime it cannot run', () => {
    setEnv({ VERCEL: '1', NODE_ENV: 'production' })

    for (const refusal of [
      creationRefusal(new Error('Status code 402 is not ok')),
      creationRefusal(new Error('Status code 403 is not ok')),
      creationRefusal(new Error('Status code 404 is not ok')),
      creationRefusal(new Error('socket hang up')),
    ]) {
      expect(refusal.message).not.toContain('CLAUDE_AGENT_RUNTIME=inline fait tourner')
      // L'issue qui existe vraiment depuis un déploiement : un runner.
      expect(refusal.message).toContain('Réparations (production)')
    }
  })

  it('keeps the OIDC advice for the refusal that is actually about identity', () => {
    const failure = creationRefusal(new Error('Status code 403 is not ok'))

    expect(failure.kind).toBe('sandbox')
    expect(failure.message).toContain('Secure Backend Access')
    expect(failure.message).toContain('VERCEL_TOKEN')
  })

  it('reads the status off the error when the client carries one', () => {
    const carried = Object.assign(new Error('request failed'), { status: 402 })

    expect(creationRefusal(carried).kind).toBe('billing')
  })

  /*
   * La reprise, qui coûtait le double pour apprendre la même chose.
   *
   * Tout ce qui portait le genre `sandbox` était retenté, refus compris : une
   * allocation épuisée bâtissait une seconde machine pour se faire refuser une
   * seconde fois. Un 4xx est une phrase — la plateforme a examiné la demande et
   * l'a rejetée ; un 5xx est un accident, et lui seul vaut une machine neuve.
   */
  it('does not pay twice to hear the same refusal', () => {
    expect(creationRefusal(new Error('Status code 402 is not ok')).retryable).toBe(false)
    expect(creationRefusal(new Error('Status code 403 is not ok')).retryable).toBe(false)
    expect(creationRefusal(new Error('Status code 404 is not ok')).retryable).toBe(false)
  })

  it('retries the platform that stumbled rather than answered', () => {
    expect(creationRefusal(new Error('Status code 503 is not ok')).retryable).toBe(true)
    expect(creationRefusal(new Error('socket hang up')).retryable).toBe(true)
  })

  it('does not read three digits of a path into a verdict', () => {
    // « 402 » se lit dans un horodatage, une taille, un numéro de port. Seule la
    // tournure du client compte, et rien d'autre.
    const failure = creationRefusal(new Error('connect ECONNREFUSED 10.0.0.1:4020'))

    expect(failure.kind).toBe('sandbox')
    expect(failure.retryable).toBe(true)
  })
})

describe('reading Claude’s answer', () => {
  it('returns the structured output and the tokens it cost', () => {
    const response = interpret('test', result())
    expect(response.structured).toEqual({ ok: true })
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(4)
    expect(response.refusal).toBeUndefined()
  })

  it('treats a refusal as an answer, not as data', () => {
    const response = interpret('test', result({ stop_reason: 'refusal' }))
    expect(response.refusal).toBeTruthy()
    expect(response.structured).toBeUndefined()
  })

  it.each([
    ['the CLI’s own blocking limit', { terminal_reason: 'blocking_limit' }],
    ['a 429 from the API', { api_error_status: 429, subtype: 'error_during_execution' }],
    [
      'the message the subscription sends',
      {
        subtype: 'error_during_execution',
        is_error: true,
        result: "You've reached your usage limit for Claude Max",
      },
    ],
  ])('names a spent allowance as a quota failure — %s', (_label, overrides) => {
    /*
     * The one error the whole migration exists to make legible. Reported as
     * anything else, the reflex is to retry or to reconfigure — and the
     * configuration that would "fix" it is an API key with a bill attached.
     */
    const failure = (() => {
      try {
        interpret('test', result(overrides as Partial<RawAgentResult>))
        return null
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(ClaudeAgentError)
    expect((failure as ClaudeAgentError).kind).toBe('quota')
    expect((failure as ClaudeAgentError).message).toMatch(/aucun basculement vers une API facturée/)
  })

  it('refuses to invent an extraction out of a missing answer', () => {
    // An empty result is not an empty chapter. Recording one as the other is
    // exactly the silent half-import the pipeline must never produce.
    expect(() => interpret('test', result({ structured_output: undefined }))).toThrow(
      ClaudeAgentError,
    )
    expect(() => interpret('test', null)).toThrow(ClaudeAgentError)
  })
})

describe('choosing who answers', () => {
  it('prefers the subscription over the metered key when nothing is specified', () => {
    setEnv({
      MODEL_PROVIDER: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-token',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    })
    expect(remoteModelProvider()).toBe('claude-max')
    expect(hasClaudeSubscription()).toBe(true)
  })

  /*
   * Une variable vide est une variable absente, pas une réponse fausse.
   *
   * `.env.example` documente ce réglage par « Vide (défaut) = le premier
   * fournisseur configuré » et le livre vide ; le schéma refusait pourtant la
   * chaîne vide, si bien que copier le fichier d'exemple comme le README le dit
   * rendait « MODEL_PROVIDER : Invalid option ». Un champ laissé blanc dans un
   * formulaire d'Actions GitHub traverse de la même façon — en chaîne vide, et
   * non en rien du tout.
   */
  it('reads a blank setting as unset rather than as a wrong answer', () => {
    setEnv({ MODEL_PROVIDER: '', CLAUDE_CODE_OAUTH_TOKEN: 'oat-token' })
    resetEnvCache()
    expect(() => env()).not.toThrow()
    expect(remoteModelProvider()).toBe('claude-max')

    // Une espace non plus : une variable collée depuis un tableau de bord en
    // arrive régulièrement avec.
    setEnv({ MODEL_PROVIDER: '   ' })
    resetEnvCache()
    expect(() => env()).not.toThrow()

    // Ce qui reste refusé : une valeur qui prétend en être une.
    setEnv({ MODEL_PROVIDER: 'gpt' })
    resetEnvCache()
    expect(() => env()).toThrow(/MODEL_PROVIDER/)
  })

  it('falls back to the metered key only when there is no subscription at all', () => {
    setEnv({
      MODEL_PROVIDER: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    })
    expect(remoteModelProvider()).toBe('anthropic')

    setEnv({ ANTHROPIC_API_KEY: undefined })
    expect(remoteModelProvider()).toBe('synthetic')
  })

  it('builds the subscription provider, and reports zero cost for its tokens', async () => {
    setEnv({
      MODEL_PROVIDER: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-token',
      ANTHROPIC_API_KEY: undefined,
      LOCAL_AI_BASE_URL: undefined,
      LOCAL_AI_MODEL: undefined,
    })

    const provider = modelProvider('auto')
    expect(provider.name).toBe('claude-max')
    expect(provider).toBeInstanceOf(ClaudeAgentProvider)

    // Nothing here is billed per token; a fabricated figure would poison the
    // one dashboard meant to be checked against something true.
    const estimate = await provider.estimate('extract', { question: 'x' })
    expect(estimate.costCents).toBe(0)
  })

  it('refuses a run launched on Claude Max with no token rather than faking one', () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined })
    // Degrading to the synthetic provider here would extract fabricated data
    // under a label that says Claude Max.
    expect(() => modelProvider('claude-max')).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('offers Claude Max as a choice, and says what is missing when it cannot', () => {
    expect(isProviderChoice('claude-max')).toBe(true)

    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined })
    const unavailable = providerOptions().find((option) => option.id === 'claude-max')
    expect(unavailable?.available).toBe(false)
    expect(unavailable?.note).toMatch(/setup-token/)

    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-token' })
    const available = providerOptions().find((option) => option.id === 'claude-max')
    expect(available?.available).toBe(true)
  })
})
