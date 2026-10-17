function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A source-declared text result becomes communication; arbitrary JSON stays intact. */
export function projectParticipantResultText(result: unknown, outputSchema: unknown): string {
  const schema = record(outputSchema), properties = record(schema?.properties)
  const textResult = schema?.type === 'object' && schema.additionalProperties === false
    && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'value'
    && properties && Object.keys(properties).length === 1 && record(properties.value)?.type === 'string'
  if (textResult) {
    let value = result
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { /* Preserve unexpected material; never repair model output. */ }
    }
    const body = record(value)
    if (body && Object.keys(body).length === 1 && typeof body.value === 'string') return body.value
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  if (typeof text !== 'string') throw new Error('participant_result_material_unavailable')
  return text
}
