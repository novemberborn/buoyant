// Manages the persistent `currentTerm` and `votedFor` state of the server.
// Provides methods for changing these values, returning a promise that fulfils
// once the new state has been persisted.
export default class State {
  constructor (persist) {
    this.currentTerm = 0
    this.votedFor = null

    this.persist = async () => {
      await persist({
        currentTerm: this.currentTerm,
        votedFor: this.votedFor
      })
    }
  }

  replace ({ currentTerm, votedFor }) {
    if (!Number.isSafeInteger(currentTerm) || currentTerm < 0) {
      throw new TypeError('Cannot replace state: current term must be a safe, non-negative integer')
    }

    this.currentTerm = currentTerm
    this.votedFor = votedFor
  }

  nextTerm (votedFor = null) {
    if (this.currentTerm === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Cannot advance term: it is already the maximum safe integer value')
    }

    this.currentTerm++
    this.votedFor = votedFor
    return this.persist()
  }

  setTerm (term) {
    if (!Number.isSafeInteger(term) || term < 1) {
      throw new TypeError('Cannot set term: must be a safe integer, greater than or equal to 1')
    }

    this.currentTerm = term
    this.votedFor = null
    return this.persist()
  }

  setTermAndVote (term, votedFor) {
    if (!Number.isSafeInteger(term) || term < 1) {
      throw new TypeError('Cannot set term: must be a safe integer, greater than or equal to 1')
    }

    this.currentTerm = term
    this.votedFor = votedFor
    return this.persist()
  }
}
