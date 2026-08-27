/**
 * A deliberately small glob matcher.
 *
 * The tool has exactly one runtime dependency (ts-morph) and it is worth keeping
 * it that way — a linter that drags in a dependency tree is a linter people
 * hesitate to install. This supports the subset that path filtering actually
 * needs: `**`, `*`, `?`, and brace alternatives like `{ts,tsx}`.
 */

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]

  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return [pattern]

  const before = pattern.slice(0, open)
  const after = pattern.slice(close + 1)
  const body = pattern.slice(open + 1, close)

  const options: string[] = []
  let current = ''
  let nested = 0
  for (const char of body) {
    if (char === '{') nested++
    if (char === '}') nested--
    if (char === ',' && nested === 0) {
      options.push(current)
      current = ''
      continue
    }
    current += char
  }
  options.push(current)

  return options.flatMap(option => expandBraces(before + option + after))
}

function toRegExp(pattern: string): RegExp {
  let source = ''
  let i = 0

  while (i < pattern.length) {
    const char = pattern[i]!

    if (char === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        // `**/` may match zero directories, so `**/*.ts` matches `a.ts`.
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 3
          continue
        }
        source += '.*'
        i += 2
        continue
      }
      source += '[^/]*'
      i += 1
      continue
    }

    if (char === '?') {
      source += '[^/]'
      i += 1
      continue
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }

  return new RegExp('^' + source + '$')
}

const cache = new Map<string, RegExp[]>()

function compile(pattern: string): RegExp[] {
  const cached = cache.get(pattern)
  if (cached) return cached

  const compiled = expandBraces(pattern).map(toRegExp)
  cache.set(pattern, compiled)
  return compiled
}

/** Match a POSIX-style relative path against one glob. */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const path = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')

  const candidates = compile(normalized)
  if (candidates.some(regex => regex.test(path))) return true

  // A bare directory name like `dist` should exclude everything under it.
  if (!normalized.includes('*') && !normalized.includes('.')) {
    return compile(`**/${normalized}/**`).some(regex => regex.test(path))
  }

  return false
}

export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchesGlob(filePath, pattern))
}
