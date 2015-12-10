// Wraps the global timer methods. Using a class means each server has its own
// instance which can then be stubbed by lolex. This is mostly useful for fuzz
// testing where the clock in each server should advance independently.
export default class Timers {
  clearInterval (intervalObject) {
    return clearInterval(intervalObject)
  }

  setInterval (callback, delay, ...args) {
    return setInterval(callback, delay, ...args)
  }

  clearTimeout (timeoutObject) {
    return clearTimeout(timeoutObject)
  }

  setTimeout (callback, delay, ...args) {
    return setTimeout(callback, delay, ...args)
  }
}
