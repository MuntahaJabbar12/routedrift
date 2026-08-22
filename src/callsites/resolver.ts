import { Node } from 'ts-morph'

export function resolveUrl(node: Node): string | null {
  if (Node.isStringLiteral(node)) {
    return node.getLiteralValue()
  }

  if (Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue()
  }

  if (Node.isTemplateExpression(node)) {
    let result = node.getHead().getLiteralText()

    for (const span of node.getTemplateSpans()) {
      result += ':param'
      result += span.getLiteral().getLiteralText()
    }

    return result
  }

  return null
}