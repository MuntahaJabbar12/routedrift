import { expect, test } from 'vitest'
import { analyze } from '../src/index.js'

test('current state: literals only', async () => {
  const findings = await analyze('test/fixtures/demo-app')
  const count = (kind: string) => findings.filter(f => f.kind === kind).length

  expect(count('broken')).toBe(1)
  expect(count('unresolved')).toBe(2)
  expect(count('dead')).toBe(4)
})

test.todo('finds the three planted bugs once template literals resolve')