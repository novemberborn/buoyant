// Manages the persistent `currentTerm` and `votedFor` state of the server.
// Provides methods for changing these values, returning a promise that fulfils
// once the new state has been persisted.
export default class State {
  constructor (persist) {
    this.currentTerm = 0
    this.votedFor = null

    this.persist = () => {
      return persist({
        currentTerm: this.currentTerm,
        votedFor: this.votedFor
      })
    }
  }

  replace ({ currentTerm, votedFor }) {
    if (!Number.isInteger(currentTerm) || currentTerm < 0 || !Number.isSafeInteger(currentTerm)) {
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
    this.currentTerm = term
    this.votedFor = null
    return this.persist()
  }

  setTermAndVote (term, votedFor) {
    this.currentTerm = term
    this.votedFor = votedFor
    return this.persist()
  }
}
