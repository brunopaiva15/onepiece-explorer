import 'server-only'
import type { AgentRequest } from './runtime.ts'

/**
 * The request, reduced to what can cross a process boundary.
 *
 * Built once, here, and used by both backends: the inline one hands it straight
 * to `query()`, the sandbox one serialises it and a script inside the microVM
 * hands it to the same `query()`. That is the point of the shape — the two
 * runtimes cannot drift into asking Claude two different things, because there
 * is one place where the question is assembled.
 *
 * What is *not* here is everything environment-specific: the process
 * environment, the working directory, the abort controller. Those are the parts
 * that differ between a laptop and a microVM, and they are exactly the parts
 * each backend supplies itself.
 */

export interface SerializableUserMessage {
  role: 'user'
  content: AgentRequest['content']
}

export interface SerializableOptions {
  systemPrompt: string
  model: string
  outputFormat: { type: 'json_schema'; schema: Record<string, unknown> }
  maxTurns: number
  tools: string[]
  mcpServers: Record<string, never>
  settingSources: string[]
  persistSession: boolean
  permissionMode: 'default'
  includePartialMessages: boolean
  thinking?: { type: 'disabled' }
  effort?: AgentRequest['effort']
}

export interface AgentPayload {
  message: SerializableUserMessage
  options: SerializableOptions
}

export function agentPayload(request: AgentRequest): AgentPayload {
  return {
    message: { role: 'user', content: request.content },
    options: {
      /*
       * A string, which in this SDK means "replace the agent's own system
       * prompt with this one" rather than "add to it".
       *
       * That distinction is the whole reason this migration is safe. The
       * project's prompts carry the anti-spoiler rules, the ontology, and the
       * instruction to read only the passages supplied; a preset coding-agent
       * prompt appended to them would be a second voice in a conversation that
       * has exactly one job.
       */
      systemPrompt: request.system,
      model: request.model,
      /*
       * The same Zod schema the caller will validate against, converted once.
       *
       * This is what replaces `output_config.format` on the Messages API, and
       * it is why nothing here has to hunt for a JSON block in prose. The model
       * is constrained to the schema; the caller then re-validates with Zod,
       * exactly as the self-hosted provider already does — the first is the
       * contract with the model, the second is what this process will believe.
       */
      outputFormat: { type: 'json_schema', schema: request.schema },
      // One question, one answer. There is nothing for a second turn to do:
      // no tools to call, and no follow-up this pipeline would ask.
      maxTurns: 1,
      /*
       * No tools. Ever. Carried over from the Anthropic provider unchanged,
       * because it is a property of this product rather than of a vendor: the
       * pages are an untrusted document, and an agent that could read a file or
       * follow a URL found in one would turn an upload into a server-side
       * request forgery. An empty array disables the built-in set outright.
       */
      tools: [],
      mcpServers: {},
      /*
       * Load no settings from disk — and this one is load-bearing twice over.
       *
       * It stops any `~/.claude` configuration, MCP server, or hook on the
       * machine from reaching a call that reads a chapter. And it stops this
       * repository's own CLAUDE.md and AGENTS.md from being pulled into the
       * prompt: instructions written for whoever edits this codebase have no
       * business in the context of a model that is being asked what happens in
       * chapter 47.
       */
      settingSources: [],
      // Nothing resumes these sessions, and a serverless filesystem has nowhere
      // to keep them.
      persistSession: false,
      // Fail closed. With no tools there is nothing to permit, and a session
      // with no human attached cannot answer a prompt — so a tool that somehow
      // existed would be refused rather than allowed.
      permissionMode: 'default',
      includePartialMessages: false,
      ...(request.thinking === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
    },
  }
}
