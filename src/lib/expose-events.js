// Exposes `on()`, `once()` and `removeListener()` methods on the `target`.
// These are nearly the same as Node's corresponding `EventEmitter` methods,
// except that a listener can only be registered once for the same event.

// The returned emitter has an `emit()` method that is not exposed on the
// `target`. Events are emitted in a next tick.
export default function exposeEvents (target) {
  const emitter = new Emitter(target)

  Object.defineProperties(target, {
    on: {
      value (name, listener) { emitter.on(name, listener); return this },
      configurable: true,
      enumerable: false,
      writable: true
    },
    once: {
      value (name, listener) { emitter.once(name, listener); return this },
      configurable: true,
      enumerable: false,
      writable: true
    },
    removeListener: {
      value (name, listener) { emitter.removeListener(name, listener); return this },
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
        this.registry.get(event).set(listener, fireOnce === listeners.get(listener))
      } else {
        this.registry.get(event).set(listener, fireOnce)
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

    process.nextTick(() => {
      for (const [listener, fireOnce] of listeners) {
        listener.call(this.context, ...params)
        if (fireOnce) {
          listeners.delete(listener)
        }
      }

      if (!listeners.size) {
        this.registry.delete(event)
      }
    })
  }
}
