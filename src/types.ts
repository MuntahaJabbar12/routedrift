export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type Route = {
  method: HttpMethod
  pattern: string
  file: string
  line: number
}

export type CallSite = {
  method: HttpMethod
  pattern: string | null
  raw: string
  file: string
  line: number
}

export type Finding =
  | { kind: 'broken'; call: CallSite }
  | { kind: 'dead'; route: Route }
  | { kind: 'unresolved'; call: CallSite }