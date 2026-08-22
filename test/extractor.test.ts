import { expect, test } from 'vitest'
import { extractNextRoutes, pathToPattern } from '../src/extractors/nextjs.js'

test('converts file paths to route patterns', () => {
  expect(pathToPattern('app/api/posts/route.ts')).toBe('/api/posts')
  expect(pathToPattern('app/api/users/[id]/route.ts')).toBe('/api/users/:id')
})

test('extracts four routes from the fixture', () => {
  const routes = extractNextRoutes('test/fixtures/demo-app')
  expect(routes).toHaveLength(4)

  const users = routes.filter(r => r.pattern === '/api/users/:id')
  expect(users.map(r => r.method).sort()).toEqual(['DELETE', 'GET'])
})