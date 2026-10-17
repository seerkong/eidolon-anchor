/** Transfers the prepared VFS lifetime to the completed bridge, or releases it on failed assembly. */
export async function withEffectiveVfsLifetime<T extends { dispose(options?: { checkpoint?: "already_saved" }): void | Promise<void> }>(
  prepared: { dispose(): void },
  assemble: () => Promise<T | null>,
): Promise<T | null> {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    prepared.dispose()
  }
  try {
    const bridge = await assemble()
    if (!bridge) {
      close()
      return null
    }
    let disposal: Promise<void> | undefined
    return {
      ...bridge,
      dispose: (options?: { checkpoint?: "already_saved" }) => disposal ??= (async () => {
        try { await bridge.dispose(options) } finally { close() }
      })(),
    }
  } catch (error) {
    close()
    throw error
  }
}
