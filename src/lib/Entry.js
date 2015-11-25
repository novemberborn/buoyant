// An entry in the log, holding a value that should be replicated in the cluster
// and applied to the server's state machine.
export default class Entry {
  constructor (index, term, value) {
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new TypeError("Parameter 'index' must be a safe integer, greater or equal than 1")
    }
    if (!Number.isSafeInteger(term) || term < 1) {
      throw new TypeError("Parameter 'term' must be a safe integer, greater or equal than 1")
    }

    Object.defineProperties(this, {
      index: { value: index, enumerable: true },
      term: { value: term, enumerable: true },
      value: { value: value, enumerable: true }
    })
  }
}
