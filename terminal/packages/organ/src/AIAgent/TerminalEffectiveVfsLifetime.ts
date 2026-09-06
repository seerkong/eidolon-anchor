/** Transfers the prepared VFS lifetime to the completed bridge, or releases it on failed assembly. */
export async function withTerminalEffectiveVfsLifetime<T extends { dispose(): void | Promise<void> }>(
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
      dispose: () => disposal ??= (async () => {
        try { await bridge.dispose() } finally { close() }
      })(),
    }
  } catch (error) {
    close()
    throw error
  }
}
