import fs from 'node:fs'
import path from 'node:path'
import type { Finding } from '../types.js'

/**
 * The baseline file.
 *
 * Adoption is the hard part of shipping a linter. A repository with two hundred
 * existing findings will not turn the tool on if the first run is a wall of red,
 * so the baseline records what is already there and reports only what is new.
 * Entries carry their file and message alongside the fingerprint purely so the
 * file is reviewable in a pull request.
 */

export const DEFAULT_BASELINE_FILE = '.routedrift-baseline.json'

export type BaselineEntry = {
  fingerprint: string
  kind: Finding['kind']
  file: string
  message: string
}

export type Baseline = {
  version: 1
  generatedAt: string
  entries: BaselineEntry[]
}

export class BaselineError extends Error {}

export function baselineFrom(findings: Finding[]): Baseline {
  const entries = findings
    .map(finding => ({
      fingerprint: finding.fingerprint,
      kind: finding.kind,
      file: finding.file,
      message: finding.message,
    }))
    .sort((a, b) =>
      a.file === b.file ? a.fingerprint.localeCompare(b.fingerprint) : a.file.localeCompare(b.file),
    )

  return { version: 1, generatedAt: new Date().toISOString(), entries }
}

export function readBaseline(file: string): Baseline | null {
  if (!fs.existsSync(file)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new BaselineError(`could not parse baseline ${file}: ${(error as Error).message}`)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Baseline).entries)
  ) {
    throw new BaselineError(`baseline ${file} is not in the expected format`)
  }

  return parsed as Baseline
}

export function writeBaseline(file: string, baseline: Baseline): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n', 'utf8')
}

export function applyBaseline(
  findings: Finding[],
  baseline: Baseline | null,
): { kept: Finding[]; baselined: number } {
  if (!baseline) return { kept: findings, baselined: 0 }

  const known = new Set(baseline.entries.map(entry => entry.fingerprint))
  const kept = findings.filter(finding => !known.has(finding.fingerprint))

  return { kept, baselined: findings.length - kept.length }
}
