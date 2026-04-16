const isDev = process.env.NODE_ENV !== 'production'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function emit(level: LogLevel, scope: string, args: unknown[]) {
  if (!isDev && level === 'debug') return
  const prefix = `[${scope}]`
  const fn =
    level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : level === 'debug' ? console.debug
    : console.info
  fn(prefix, ...args)
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', scope, args),
    info: (...args: unknown[]) => emit('info', scope, args),
    warn: (...args: unknown[]) => emit('warn', scope, args),
    error: (...args: unknown[]) => emit('error', scope, args),
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}
