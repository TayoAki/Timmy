/** The first JSON object in a model's answer, or an empty object when there isn't one. Models sometimes wrap JSON in prose. */
export function jsonObject<T extends object = Record<string, unknown>>(text: string): Partial<T> {
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}
