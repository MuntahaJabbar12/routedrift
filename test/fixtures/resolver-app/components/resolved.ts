// Every URL shape the resolver is expected to fold down to a pattern.
//
// This fixture must produce zero errors and zero warnings. It is the
// false-positive regression test: if a change to the resolution engine starts
// reporting anything here, the change is wrong.

import axios from 'axios'
import { API_BASE, ENDPOINTS, Endpoint } from '../lib/endpoints.js'
import { api } from '../lib/client.js'

const HEALTH = '/api/health'
const METHOD = 'PATCH'

// 1. Plain string literal.
export const health = () => fetch('/api/health')

// 2. Template literal with an interpolated parameter.
export const user = (userId: string) => fetch(`/api/users/${userId}`)

// 3. Constant declared in this file.
export const healthViaConst = () => fetch(HEALTH)

// 4. Constant traced across a module boundary.
export const healthViaBase = () => fetch(`${API_BASE}/health`)

// 5. Property of a const object, imported.
export const healthViaObject = () => fetch(ENDPOINTS.health)

// 6. String enum member, imported.
export const orderItems = (orderId: string) => fetch(`${Endpoint.Orders}/${orderId}/items`)

// 7. String concatenation rather than a template.
export const userViaConcat = (userId: string) => fetch('/api/users/' + userId)

// 8. Ternary — both branches are kept as candidates.
export const either = (deep: boolean) => fetch(deep ? '/api/health' : '/api/users/1')

// 9. Query strings are not part of the path.
export const healthDeep = () => fetch('/api/health?deep=1')

// 10. Catch-all route: app/api/files/[...path]/route.ts
export const file = () => fetch('/api/files/a/b/c.png')

// 11. An axios instance created by axios.create in another module.
export const healthViaAxiosInstance = () => api.get('/api/health')

// 12. axios verb method.
export const patchUser = (userId: string) => axios.patch(`/api/users/${userId}`, {})

// 13. axios called with a config object.
export const createItem = () => axios({ url: '/api/orders/1/items', method: 'post' })

// 14. Method supplied by a constant.
export const patchViaConst = (userId: string) =>
  fetch(`/api/users/${userId}`, { method: METHOD })

// 15. Trailing slashes are normalised away.
export const healthTrailing = () => fetch('/api/health/')

// 16. Options spread in from elsewhere: the path is known, the verb is not, so
//     matching falls back to the path alone rather than assuming GET.
export const healthWithSpreadInit = (init: RequestInit) => fetch('/api/health', { ...init })

// 17. Imported constant as the base of a longer template.
export const orderItemsViaBase = (orderId: string) =>
  fetch(`${API_BASE}/orders/${orderId}/items`)

// 18. Numeric interpolation folds to a literal segment.
export const firstUser = () => fetch(`/api/users/${1}`)
