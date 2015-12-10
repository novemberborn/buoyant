import {
  AppendEntries, RejectEntries,
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
    becomeLeader,
    convertToFollower,
    crashHandler,
    electionTimeout,
    log,
    nonPeerReceiver,
    ourId,
    peers,
    state
  }) {
    this.becomeLeader = becomeLeader
    this.convertToFollower = convertToFollower
    this.electionTimeout = electionTimeout
    this.log = log
    this.ourId = ourId
    this.peers = peers
    this.state = state

    this.destroyed = false
    this.timer = null
    this.votesRequired = 0
    this.votesAlreadyReceived = null

    this.scheduler = new Scheduler(crashHandler)
    this.inputConsumer = new InputConsumer({
      crashHandler,
      handleMessage: (peer, message) => this.handleMessage(peer, message),
      nonPeerReceiver,
      peers,
      scheduler: this.scheduler
    })
  }

  start () {
    this.requestVote()

    // Start last so it doesn't preempt requesting votes.
    this.inputConsumer.start()
  }

  destroy () {
    this.destroyed = true
    clearTimeout(this.timer)
    this.inputConsumer.stop()
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
    // Reject the entries if they're part of an older term. The peer has already
    // been deposed as leader but it just doesn't know it yet. Let it know by
    // sending the current term in the reply.
    if (term === this.state.currentTerm) {
      this.convertToFollower([peer, message])
    } else {
      // handleAppendEntries() is never called directly, only via
      // handleMessage() which already checks if the term is newer. Thus a
      // simple else branch can be used, which also helps with code coverage
      // calculations.
      peer.send({
        type: RejectEntries,
        term: this.state.currentTerm
      })
    }
  }
}
