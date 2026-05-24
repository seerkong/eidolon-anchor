export function lazy<T>(factory: () => T): () => T {
  let created = false
  let value: T
  return () => {
    if (!created) {
      value = factory()
      created = true
    }
    return value
  }
}
