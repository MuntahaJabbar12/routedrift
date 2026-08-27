// URLs the resolver cannot pin down, and one that is none of our business.
//
// The important assertion about this file is negative: none of these produce an
// error. Guessing at any of them would be how the tool loses credibility.

import { buildUrl } from '../lib/endpoints.js'

// Built by a helper function. Solving this properly needs runtime tracing, which
// the project deliberately does not do.
export const viaBuilder = () => fetch(buildUrl('users'))

// The base comes from the environment, so the path is visible but the origin is
// not. Reported as unresolved, and the static tail still counts as evidence that
// something under /api/health is being called.
export const viaEnv = () => fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/health`)

// A reassignable binding. Substituting its first value would be a guess.
export const viaMutable = (flag: boolean) => {
  let base = '/api'
  if (flag) base = '/api/v2'
  return fetch(base + '/health')
}

// Somebody else's API. Not drift in this repository, so it is skipped entirely
// rather than counted against resolution coverage.
export const external = () =>
  fetch('https://api.stripe.com/v1/charges', { method: 'POST' })
