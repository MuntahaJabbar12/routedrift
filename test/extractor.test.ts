import { expect, test } from 'vitest'
import { extractNextRoutes, pathToPattern } from '../src/extractors/nextjs.js'
import { scanCallSites } from '../src/callsites/scanner.js'

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

test('finds three fetch calls in the fixture', () => {
  const sites = scanCallSites('test/fixtures/demo-app')
  expect(sites).toHaveLength(3)

  const posts = sites.find(s => s.pattern === '/api/posts')
  expect(posts?.method).toBe('POST')

  expect(sites.filter(s => s.pattern === null)).toHaveLength(0)
})
