import {
  AppendEntries,
  RequestVote, DenyVote, GrantVote
} from '../symbols'

import InputConsumer from '../InputConsumer'
import Scheduler from '../Scheduler'

const handlerMap = Object.create(null, {
  [RequestVote]: { value: 'handleRequestVote' },
  [GrantVote]: { value: 'handleGrantVote' },
  [AppendEntries]: { value: 'handleAppendEntries' }
})

// Implements candidate behavior according to Raft.
export default class Candidate {
  constructor ({
    ourId,
    electionTimeout,
    state,
    log,
    peers,
    nonPeerReceiver,
    crashHandler,
    convertToFollower,
    becomeLeader
  }) {
    this.ourId = ourId
    this.electionTimeout = electionTimeout
    this.state = state
    this.log = log
    this.peers = peers
    this.convertToFollower = convertToFollower
    this.becomeLeader = becomeLeader

    this.destroyed = false
    this.timer = null
    this.votesRequired = 0
    this.votesAlreadyReceived = null

    this.scheduler = new Scheduler(crashHandler)
    this.inputConsumer = new InputConsumer({
      peers,
      nonPeerReceiver,
      scheduler: this.scheduler,
      handleMessage: this.handleMessage.bind(this),
      crashHandler
    })

    this.requestVote()
  }

  destroy () {
    this.destroyed = true
    clearTimeout(this.timer)
    this.inputConsumer.halt()
    this.scheduler.abort()
  }

  requestVote () {
    this.scheduler.asap(null, () => {
      // A majority of votes is required. Note that the candidate votes for
      // itself, so at least half of the remaining votes are needed.
      this.votesRequired = Math.ceil(this.peers.length / 2)
      // Track which peers granted their vote to avoid double-counting.
      this.votesAlreadyReceived = new Set()

      return this.state.nextTerm(this.ourId).then(() => {
        if (this.destroyed) return

        for (const peer of this.peers) {
          peer.send({
            type: RequestVote,
            term: this.state.currentTerm,
            lastLogIndex: this.log.lastIndex,
            lastLogTerm: this.log.lastTerm
          })
        }

        // Start the timer for this election. Intervals aren't used as they
        // complicate the logic. As the server isn't expected to remain a
        // candidate for very long there shouldn't be too many timers created.
        this.timer = setTimeout(() => this.requestVote(), this.electionTimeout)
      })
    })
  }

  handleMessage (peer, message) {
    const { type, term } = message

    // Convert to follower if the message has a newer term.
    if (term > this.state.currentTerm) {
      return this.state.setTerm(term).then(() => {
        if (this.destroyed) return

        this.convertToFollower([peer, message])
      })
    }

    if (handlerMap[type]) return this[handlerMap[type]](peer, term, message)
  }

  handleRequestVote (peer, term) {
    // Deny the vote if it's for an older term. Reply with the current term so
    // the other candidate can update itself.
    if (term < this.state.currentTerm) {
      peer.send({
        type: DenyVote,
        term: this.state.currentTerm
      })
    }
  }

  handleGrantVote (peer, term) {
    // Accept the vote if it's for the current term and from a peer that hasn't
    // previously granted its vote. Become leader once a majority has been
    // reached.
    if (term !== this.state.currentTerm || this.votesAlreadyReceived.has(peer.id)) {
      return
    }

    this.votesAlreadyReceived.add(peer.id)
    this.votesRequired--
    if (this.votesRequired === 0) {
      this.becomeLeader()
    }
  }

  handleAppendEntries (peer, term, message) {
    // Convert to follower if the message is from a leader in the current term.
    if (term === this.state.currentTerm) {
      this.convertToFollower([peer, message])
    }
  }
}
