// A shared endpoint module — the pattern the resolver has to follow across a
// module boundary, because this is how real codebases store their URLs.

export const API_BASE = '/api'

export const ENDPOINTS = {
  health: '/api/health',
  users: '/api/users',
} as const

export enum Endpoint {
  Orders = '/api/orders',
}

export function buildUrl(resource: string): string {
  return `${API_BASE}/${resource}`
}
