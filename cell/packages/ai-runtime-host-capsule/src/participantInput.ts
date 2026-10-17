/** A shell text adapter over an admitted input schema, never a guessed field name.
 * Structured inputs remain exact caller JSON; ambiguous schemas require that form.
 */
export function projectParticipantTextInput(schema: unknown, text: string): unknown {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        throw new Error('participant_structured_input_required');
    const value = schema as Record<string, unknown>;
    if (value.type === 'string')
        return text;
    if (value.type !== 'object' || !value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties))
        throw new Error('participant_structured_input_required');
    const properties = Object.entries(value.properties);
    // Only a single declared string slot is unambiguous. Do not choose among optional
    // fields, run a prefix, or infer the task contract from a prompt/display name.
    if (properties.length !== 1)
        throw new Error('participant_structured_input_required');
    const [key, property] = properties[0]!;
    if (!property || typeof property !== 'object' || Array.isArray(property) || (property as Record<string, unknown>).type !== 'string'
        || value.required !== undefined && (!Array.isArray(value.required) || value.required.some(required => required !== key)))
        throw new Error('participant_structured_input_required');
    return { [key]: text };
}
