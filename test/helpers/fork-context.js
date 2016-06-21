const stateMap = new WeakMap()

function runHooks (hooks, select, t) {
  const queue = hooks.map(hook => hook[select]).filter(Boolean)
  const next = () => {
    while (queue.length) {
      const fn = queue.shift()
      const promise = fn(t)
      if (promise && typeof promise.then === 'function') {
        return promise.then(next)
      }
    }
  }
  return next()
}

const serialGetter = function () {
  const state = stateMap.get(this)
  const { serial: wasSerial } = state

  const test = (...args) => {
    try {
      state.serial = true
      this.test(...args)
    } finally {
      state.serial = wasSerial
    }
  }

  test.serial = test
  test.test = (...args) => test(...args)

  return test
}

class Context {
  constructor (test, hooks = [], serial = false) {
    stateMap.set(this, { test, hooks, serial })
    this.test = this.test.bind(this)

    Object.defineProperty(this.test, 'serial', {
      get: serialGetter.bind(this)
    })
  }

  get always () {
    return {
      afterEach: fn => {
        stateMap.get(this).hooks.push({ alwaysAfterEach: fn })
        return this
      }
    }
  }

  get serial () {
    return serialGetter.call(this)
  }

  fork ({ serial: forceSerial = false } = {}) {
    const { test, hooks, serial } = stateMap.get(this)
    return new Context(test, hooks.slice(), forceSerial || serial)
  }

  beforeEach (fn) {
    stateMap.get(this).hooks.push({ beforeEach: fn })
    return this
  }

  afterEach (fn) {
    stateMap.get(this).push({ afterEach: fn })
    return this
  }

  test (...args) {
    const { test, hooks, serial } = stateMap.get(this)

    const fnIx = typeof args[0] === 'function' ? 0 : 1
    const fn = args[fnIx]
    args[fnIx] = (t, ...args) => {
      const runAfterEach = () => runHooks(hooks, 'afterEach', t)
      const runAlwaysAfterEach = () => runHooks(hooks, 'alwaysAfterEach', t)
      const runAlwaysAfterEachWithRethrow = err => {
        return Promise.resolve(runAlwaysAfterEach).then(() => {
          throw err
        })
      }

      const beforeEachPromise = runHooks(hooks, 'beforeEach', t)
      if (beforeEachPromise && typeof beforeEachPromise.then === 'function') {
        return beforeEachPromise
          .then(() => fn(t, ...args))
          .then(runAfterEach)
          .then(runAlwaysAfterEach, runAlwaysAfterEachWithRethrow)
      }

      let promise
      try {
        const runPromise = fn(t, ...args)
        if (runPromise && typeof runPromise.then === 'function') {
          promise = runPromise
            .then(runAfterEach)
            .then(runAlwaysAfterEach, runAlwaysAfterEachWithRethrow)
        } else {
          // FIXME: Ensure this doesn't run if an assertion fails
          const afterEachPromise = runAfterEach()
          if (afterEachPromise && typeof afterEachPromise.then === 'function') {
            promise = afterEachPromise.then(runAlwaysAfterEach, runAlwaysAfterEachWithRethrow)
          }
        }
      } finally {
        if (!promise) {
          promise = runAlwaysAfterEach()
        }
      }

      return promise
    }

    if (fn.title) {
      if (fnIx === 1) {
        args[0] = fn.title(args[0], ...args.slice(2))
      } else {
        args.unshift(fn.title('', ...args.slice(1)))
      }
    }

    if (serial) {
      test.serial(...args)
    } else {
      test(...args)
    }
  }
}

const rootContext = new Context(require('ava'))
module.exports = rootContext.fork.bind(rootContext)
