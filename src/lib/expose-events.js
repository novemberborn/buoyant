// Exposes `on()`, `once()` and `removeListener()` methods on the `target`.
// These are nearly the same as Node's corresponding `EventEmitter` methods,
// except that a listener can only be registered once for the same event.

// The returned emitter has an `emit()` method that is not exposed on the
// `target`. Events are emitted synchronously, however if a listener throws an
// exception no remaining listeners are invoked. The error is rethrown
// asynchronously.
import process from './process'

export default function exposeEvents (target) {
  const emitter = new Emitter(target)

  Object.defineProperties(target, {
    on: {
      value (event, listener) { emitter.on(event, listener); return this },
      configurable: true,
      enumerable: false,
      writable: true
    },
    once: {
      value (event, listener) { emitter.once(event, listener); return this },
      configurable: true,
      enumerable: false,
      writable: true
    },
    removeListener: {
      value (event, listener) { emitter.removeListener(event, listener); return this },
      configurable: true,
      enumerable: false,
      writable: true
    }
  })

  return emitter
}

class Emitter {
  constructor (context) {
    this.context = context
    this.registry = new Map()
  }

  on (event, listener) {
    this.addListener(event, listener, false)
  }

  once (event, listener) {
    this.addListener(event, listener, true)
  }

  addListener (event, listener, fireOnce) {
    if (typeof listener !== 'function') {
      throw new TypeError(`Parameter 'listener' must be a function, not ${typeof listener}`)
    }

    if (this.registry.has(event)) {
      const listeners = this.registry.get(event)
      if (listeners.has(listener)) {
        // fireOnce can only be true if the previous registration was supposed
        // to fire once.
        listeners.set(listener, fireOnce === listeners.get(listener))
      } else {
        listeners.set(listener, fireOnce)
      }
    } else {
      this.registry.set(event, new Map().set(listener, fireOnce))
    }
  }

  removeListener (event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError(`Parameter 'listener' must be a function, not ${typeof listener}`)
    }

    const listeners = this.registry.get(event)
    if (!listeners) {
      return
    }

    listeners.delete(listener)
    if (!listeners.size) {
      this.registry.delete(event)
    }
  }

  emit (event, ...params) {
    const listeners = this.registry.get(event)
    if (!listeners) {
      return
    }

    for (const [listener, fireOnce] of listeners) {
      try {
        listener.call(this.context, ...params)
      } catch (err) {
        process.nextTick(() => { throw err })
        break
      } finally {
        if (fireOnce) {
          listeners.delete(listener)
        }
      }
    }

    if (!listeners.size) {
      this.registry.delete(event)
    }
  }
}
