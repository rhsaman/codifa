import type { ProviderKind } from '../types'

/**
 * Heuristic detection of whether a model id exposes a reasoning mode the UI can
 * steer (via thinking level / reasoning effort). Local adapters (ollama, custom
 * = llama.cpp/vLLM/LM Studio) are conservative: a model must clearly look like a
 * reasoning model to be flagged. Cloud gateways get a broader net since the
 * underlying model families are known to support reasoning effort.
 */

const REASONING_PATTERNS: RegExp[] = [
  /\b(qwen3|qwq)\b/i,
  /deepseek[-_]?r1\b/i,
  /\b(o1|o3|o4)([-._-]|$)/i,
  /\bgpt[-_.]?5/i,
  /\breason(er|ing)?\b/i,
  /\bthinking\b/i,
  /glm[-_.]?4\.(5|6)/i,
  /kimi[-_.]?k2[-_.]?thinking/i,
  /\bturbo[-_.]?reasoning/i,
  /\bexp\b.*\breason/i,
]

export function supportsReasoning(
  modelId: string,
  kind: ProviderKind = 'opencode',
  reasoning?: boolean | null,
): boolean {
  const id = (modelId || '').trim()
  if (!id) return false
  if (typeof reasoning === 'boolean') return reasoning
  return REASONING_PATTERNS.some((re) => re.test(id))
}
