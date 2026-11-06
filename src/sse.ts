/**
 * Aggregate an OpenAI chat-completions SSE stream into one completion object.
 *
 * Carpe specifics handled:
 *   - the final usage chunk (`choices: []`) carries `carpe_cost_usdc_micro` and
 *     `carpe_credits` — the authoritative cost of a streamed request;
 *   - the router's silence guard sends `: carpe-route market=… reason=…` comments
 *     instead of headers when no market answered within 20 s;
 *   - a failure after the headers arrives as `data: {"error":{…}}`.
 */
import { CarpeError } from './errors.js'

export interface AggregatedCompletion {
  completion: Record<string, unknown>
  costUsd?: number
  route?: { market?: string; reason?: string; attempts?: string }
}

interface ToolCallAcc {
  id?: string
  type?: string
  function: { name: string; arguments: string }
}

export async function aggregateChatStream(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<AggregatedCompletion> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let total = 0
  let id: string | undefined
  let model: string | undefined
  let created: number | undefined
  let content = ''
  let reasoning = ''
  let role = 'assistant'
  let finishReason: string | null = null
  let usage: Record<string, unknown> | undefined
  let costUsd: number | undefined
  const toolCalls: ToolCallAcc[] = []
  const route: AggregatedCompletion['route'] = {}
  let done = false

  const handleData = (payload: string) => {
    if (payload === '[DONE]') {
      done = true
      return
    }
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(payload)
    } catch {
      return
    }
    if (chunk.error && typeof chunk.error === 'object') {
      const e = chunk.error as Record<string, unknown>
      throw new CarpeError({
        status: 200,
        code: String(e.code ?? e.type ?? 'STREAM_ERROR'),
        message: String(e.message ?? 'The stream failed after it started'),
      })
    }
    id ??= chunk.id as string | undefined
    model ??= chunk.model as string | undefined
    created ??= chunk.created as number | undefined
    if (chunk.usage && typeof chunk.usage === 'object') {
      usage = chunk.usage as Record<string, unknown>
      const micro = Number(usage.carpe_cost_usdc_micro)
      if (Number.isFinite(micro)) costUsd = micro / 1e6
    }
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : []
    for (const c of choices) {
      if ((c.index ?? 0) !== 0) continue
      const d = (c.delta ?? {}) as Record<string, unknown>
      if (typeof d.role === 'string') role = d.role
      if (typeof d.content === 'string') content += d.content
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
      if (typeof d.reasoning === 'string') reasoning += d.reasoning
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls as Record<string, unknown>[]) {
          const i = typeof tc.index === 'number' ? tc.index : toolCalls.length
          toolCalls[i] ??= { function: { name: '', arguments: '' } }
          const acc = toolCalls[i]
          if (typeof tc.id === 'string') acc.id = tc.id
          if (typeof tc.type === 'string') acc.type = tc.type
          const f = (tc.function ?? {}) as Record<string, unknown>
          if (typeof f.name === 'string') acc.function.name += f.name
          if (typeof f.arguments === 'string') acc.function.arguments += f.arguments
        }
      }
      if (typeof c.finish_reason === 'string') finishReason = c.finish_reason
    }
  }

  const handleLine = (line: string) => {
    if (line.startsWith('data:')) handleData(line.slice(5).trim())
    else if (line.startsWith(': carpe-route')) {
      for (const m of line.matchAll(/(market|reason|attempts)=("[^"]*"|\S+)/g)) {
        route[m[1] as 'market' | 'reason' | 'attempts'] = m[2].replace(/^"|"$/g, '')
      }
    }
  }

  while (!done) {
    const { done: end, value } = await reader.read()
    if (end) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new CarpeError({ status: 200, code: 'RESPONSE_TOO_LARGE', message: `Streamed answer exceeds ${maxBytes} bytes.` })
    }
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line) handleLine(line)
      if (done) break
    }
  }
  if (buf.trim()) handleLine(buf.trim())
  if (!done && finishReason === null && usage === undefined) {
    throw new CarpeError({ status: 200, code: 'STREAM_INTERRUPTED', message: 'The answer stream ended before completion. The request may still have been billed — check carpe_usage_history.' })
  }

  const message: Record<string, unknown> = { role, content: content || (toolCalls.length ? null : '') }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean).map((t) => ({ id: t.id, type: t.type ?? 'function', function: t.function }))
  return {
    completion: {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    },
    costUsd,
    route: Object.keys(route).length ? route : undefined,
  }
}
