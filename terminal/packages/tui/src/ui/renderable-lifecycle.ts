type FocusableRenderable = {
  isDestroyed?: boolean
  focus(): void
}

export function scheduleRenderableFocus<T extends FocusableRenderable>(
  resolveTarget: () => T | null | undefined,
  afterFocus?: (target: T) => void,
  delay = 1,
) {
  let cancelled = false
  const timer = setTimeout(() => {
    if (cancelled) return
    const target = resolveTarget()
    if (!target || target.isDestroyed) return
    target.focus()
    if (cancelled || target.isDestroyed) return
    afterFocus?.(target)
  }, delay)

  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
