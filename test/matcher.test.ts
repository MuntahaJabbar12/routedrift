import { expect, test } from 'vitest'
import { analyze } from '../src/index.js'

test('finds the three planted bugs', async () => {
  const findings = await analyze('test/fixtures/demo-app')
  expect(findings.filter(f => f.kind === 'broken')).toHaveLength(2)
  expect(findings.filter(f => f.kind === 'dead')).toHaveLength(1)
})