import Error from 'es6-error'

export class ElectionSafetyViolation extends Error {
  constructor ({ address, timestamp, term, otherLeaders }) {
    super()
    Object.assign(this, { address, timestamp, term, otherLeaders })
  }
}

export class LeaderAppendOnlyViolation extends Error {
  constructor ({ address, timestamp, entry, lastApplied }) {
    super()
    Object.assign(this, { address, timestamp, entry, lastApplied })
  }
}

export class LeaderCompletenessViolation extends Error {
  constructor ({ address, index, term, timestamp }) {
    super()
    Object.assign(this, { address, index, term, timestamp })
  }
}

export class LogMatchingViolation extends Error {
  constructor ({ index, first, second }) {
    super()
    Object.assign(this, { first, second })
  }
}

export class StateMachineSafetyViolation extends Error {
  constructor ({ address, timestamp, entry, peer }) {
    super()
    Object.assign(this, { address, timestamp, entry, peer })
  }
}
