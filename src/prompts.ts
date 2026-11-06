/** Prompt templates that chain the tools the intended way. */
import { z } from 'zod'

export interface PromptDef {
  name: string
  title: string
  description: string
  argsSchema: Record<string, z.ZodTypeAny>
  build: (args: Record<string, string | undefined>) => { messages: { role: 'user'; content: { type: 'text'; text: string } }[] }
}

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] })

export function buildPrompts(): PromptDef[] {
  return [
    {
      name: 'cheapest_model_for',
      title: 'Cheapest model for a task',
      description: 'Pick a suitable model, compare prices on /v1 and /router with carpe_quote, then run the task on the cheapest acceptable option.',
      argsSchema: { task: z.string().describe('What to do'), constraints: z.string().optional().describe('e.g. "must be private", "needs vision"') },
      build: (a) =>
        user(
          `Task: ${a.task}\n${a.constraints ? `Constraints: ${a.constraints}\n` : ''}` +
            '1. Use carpe_list_models (type "text", and capability filters if needed) to shortlist 3 suitable models.\n' +
            '2. For each, call carpe_quote with the task text as prompt and a realistic max_tokens.\n' +
            '3. Choose: if the task is confidential use route "carpe" (/v1, TEE), otherwise the cheapest of surfaces.carpe and surfaces.router.best.\n' +
            '4. Run it with carpe_chat on that route and model, then report the answer, the cost and the market that served it.',
        ),
    },
    {
      name: 'cost_report',
      title: 'Carpe spend report',
      description: 'Summarise the account spend: balance, usage by model and day, router savings.',
      argsSchema: { days: z.string().optional().describe('Window in days (default 7)') },
      build: (a) =>
        user(
          `Build a short cost report for the last ${a.days ?? '7'} days: call carpe_balance, carpe_usage_summary (days ${a.days ?? '7'}), carpe_routing_summary and carpe_session_spend. ` +
            'Give totals, top 5 models by cost, the trend by day, and how much the /router saved versus Carpe-only prices. Flag if the available balance covers less than a week at this pace.',
        ),
    },
    {
      name: 'private_inference',
      title: 'Private inference',
      description: 'Answer a confidential request on /v1 only (Carpe TEE), with a model Venice runs privately.',
      argsSchema: { request: z.string().describe('The confidential request') },
      build: (a) =>
        user(
          'This request is confidential. Use carpe_list_models with privacy "private" and type "text" to pick a capable model, then call carpe_chat with route "carpe" (never "router"). ' +
            `Confirm in the answer that route.tee is true.\n\nRequest:\n${a.request}`,
        ),
    },
  ]
}
