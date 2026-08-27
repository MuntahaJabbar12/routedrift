import { expect, test } from 'vitest'
import { analyze } from '../src/index.js'

test('catches both broken calls and all unused routes', async () => {
  const result = await analyze('test/fixtures/demo-app')
  const findings = result.findings
  const count = (kind: string) => findings.filter(f => f.kind === kind).length

  expect(count('broken')).toBe(2)
  expect(count('dead')).toBe(1)
  expect(count('unresolved')).toBe(0)

  expect(result.coverage.percent).toBe(100)
})