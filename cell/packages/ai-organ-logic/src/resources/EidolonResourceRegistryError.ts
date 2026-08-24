export class EidolonResourceRegistryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(`${code}: ${message}`)
    this.name = "EidolonResourceRegistryError"
  }
}
