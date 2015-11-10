// An entry in the log, holding a value that should be replicated in the cluster
// and applied to the server's state machine.
export default class Entry {
  constructor (index, term, value) {
    if (!Number.isSafeInteger(index)) {
      throw new TypeError('Index is not a safe integer')
    }

    Object.defineProperties(this, {
      index: { value: index, enumerable: true },
      term: { value: term, enumerable: true },
      value: { value: value, enumerable: true }
    })
  }
}
