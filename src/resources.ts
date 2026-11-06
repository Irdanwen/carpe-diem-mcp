/** Read-only resources: live catalogue, prices and router markets. */
import type { CarpeClient } from './carpe-client.js'

export interface ResourceDef {
  uri: string
  name: string
  description: string
  mimeType: string
  read: () => Promise<{ uri: string; mimeType: string; text: string }>
}

export function buildResources(client: CarpeClient): ResourceDef[] {
  const res = (uri: string, name: string, description: string, path: string): ResourceDef => ({
    uri,
    name,
    description,
    mimeType: 'application/json',
    read: async () => ({ uri, mimeType: 'application/json', text: (await client.request({ path, auth: 'none' })).text() }),
  })
  return [
    res('carpe://models', 'Carpe Diem models', 'Live model catalogue (GET /v1/models): ids, carpe_diem_type, capabilities, constraints, voices.', '/v1/models'),
    res('carpe://pricing', 'Carpe Diem prices', 'Live prices (GET /pricing): USD per 1M tokens and fixed costs per image / call.', '/pricing'),
    res('carpe://markets', 'Router markets', 'Best-price router state (GET /router/markets): markets on, fee, latency.', '/router/markets'),
  ]
}
