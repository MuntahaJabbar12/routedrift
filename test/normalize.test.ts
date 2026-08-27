import { describe, expect, test } from 'vitest'
import {
  classifyUrl,
  hasCatchAll,
  isDynamicSegment,
  normalizePattern,
  paramNameFor,
  staticPrefixOf,
  stripQueryAndHash,
} from '../src/core/normalize.js'

describe('normalizePattern', () => {
  test('produces one canonical form for equivalent paths', () => {
    for (const input of ['/api/users', 'api/users', '/api/users/', '//api//users', './api/users']) {
      expect(normalizePattern(input)).toBe('/api/users')
    }
  })

  test('keeps the root path addressable', () => {
    expect(normalizePattern('/')).toBe('/')
    expect(normalizePattern('')).toBe('/')
  })

  test('converts Windows separators', () => {
    expect(normalizePattern('\\api\\users')).toBe('/api/users')
  })
})

describe('stripQueryAndHash', () => {
  test('drops everything from the first ? or #', () => {
    expect(stripQueryAndHash('/api/users?page=1')).toBe('/api/users')
    expect(stripQueryAndHash('/api/users#top')).toBe('/api/users')
    expect(stripQueryAndHash('/api/users?a=1#top')).toBe('/api/users')
    expect(stripQueryAndHash('/api/users')).toBe('/api/users')
  })
})

describe('classifyUrl', () => {
  test('treats a rooted path as ours', () => {
    expect(classifyUrl('/api/users')).toEqual({ kind: 'internal', pattern: '/api/users' })
  })

  test('ignores query strings when forming the pattern', () => {
    expect(classifyUrl('/api/users?page=2')).toEqual({ kind: 'internal', pattern: '/api/users' })
  })

  test('treats another origin as external', () => {
    expect(classifyUrl('https://api.stripe.com/v1/charges').kind).toBe('external')
    expect(classifyUrl('//cdn.example.com/asset.png').kind).toBe('external')
  })

  test('accepts an absolute URL when the origin is configured as ours', () => {
    expect(classifyUrl('https://app.example.com/api/users', ['https://app.example.com'])).toEqual({
      kind: 'internal',
      pattern: '/api/users',
    })
  })

  test('refuses to guess when the base is dynamic', () => {
    // This is the case that would otherwise become a false "broken call".
    expect(classifyUrl(':API_URL/api/users').kind).toBe('dynamic-base')
    expect(classifyUrl('/:base/users').kind).toBe('dynamic-base')
  })

  test('refuses to guess for a relative URL', () => {
    expect(classifyUrl('users/5').kind).toBe('relative')
    expect(classifyUrl('').kind).toBe('relative')
  })
})

describe('segment helpers', () => {
  test('recognises dynamic segments from either syntax', () => {
    expect(isDynamicSegment(':id')).toBe(true)
    expect(isDynamicSegment('*')).toBe(true)
    expect(isDynamicSegment('[id]')).toBe(true)
    expect(isDynamicSegment('users')).toBe(false)
  })

  test('detects catch-all patterns', () => {
    expect(hasCatchAll('/api/files/*')).toBe(true)
    expect(hasCatchAll('/api/files')).toBe(false)
  })

  test('names parameters after the interpolated expression', () => {
    expect(paramNameFor('userId')).toBe(':userId')
    expect(paramNameFor('user.id')).toBe(':id')
    expect(paramNameFor('encodeURIComponent(slug)')).toBe(':slug')
  })

  test('reports the literal prefix of a pattern', () => {
    expect(staticPrefixOf('/api/users/:id')).toBe('/api/users')
    expect(staticPrefixOf('/api/health')).toBe('/api/health')
    expect(staticPrefixOf('/:id/edit')).toBe(null)
  })
})
