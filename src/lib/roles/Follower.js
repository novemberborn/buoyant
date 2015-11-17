import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote, GrantVote
} from '../symbols'

import InputConsumer from '../InputConsumer'
import Scheduler from '../Scheduler'

const handlerMap = Object.create(null, {
  [RequestVote]: { value: 'handleRequestVote' },
  [AppendEntries]: { value: 'handleAppendEntries' }
})

// Implements follower behavior according to Raft.
export default class Follower {
  constructor ({
    electionTimeout,
    state,
    log,
    peers,
    nonPeerReceiver,
    crashHandler,
    convertToCandidate,
    replayMessage
  }) {
    this.electionTimeout = electionTimeout
    this.state = state
    this.log = log
    this.convertToCandidate = convertToCandidate

    this.destroyed = false
    this.commitIndex = 0

    this.skipNextElection = false
    this.scheduledTimeoutHandler = false
    this.timer = setInterval(() => this.maybeStartElection(), this.electionTimeout)

    this.scheduler = new Scheduler(crashHandler)
    this.inputConsumer = new InputConsumer({
      initial: replayMessage,
      peers,
      nonPeerReceiver,
      scheduler: this.scheduler,
      handleMessage: this.handleMessage.bind(this),
      crashHandler
    })
  }

  destroy () {
    this.destroyed = true
    clearInterval(this.timer)
    this.inputConsumer.halt()
    this.scheduler.abort()
  }

  maybeStartElection () {
    // Use the scheduler to avoid interrupting an active operation. However the
    // scheduler may be blocked for longer than the election timeout. Ignore
    // further invocations until the first timeout has been handled.
    if (this.scheduledTimeoutHandler) return

    this.scheduledTimeoutHandler = true
    this.scheduler.asap(null, () => {
      this.scheduledTimeoutHandler = false

      // Rather than creating a new timer after receiving a message from the
      // leader, set a flag to skip the next election. This should be more
      // efficient, although it may cause the follower to delay a bit longer
      // before starting a new election.
      if (this.skipNextElection) {
        this.skipNextElection = false
        return
      }

      // The election timeout is legit, become a candidate.
      this.convertToCandidate()
    })
  }

  handleMessage (peer, message) {
    const { type } = message
    if (handlerMap[type]) return this[handlerMap[type]](peer, message)
  }

  handleRequestVote (peer, { term, lastLogIndex, lastLogTerm }) {
    // Deny the vote if it's for an older term. Send the current term in the
    // reply so the other candidate can update itself.
    if (term < this.state.currentTerm) {
      peer.send({
        type: DenyVote,
        term: this.state.currentTerm
      })
      return
    }

    // Grant the vote on a first-come first-serve basis, or if the vote was
    // already granted to the candidate in the current term.
    const allowVote = this.state.votedFor === null || this.state.votedFor === peer.id
    // The candidate's log must be up-to-date however.
    const notOutdated = this.log.lastIndex <= lastLogIndex && this.log.lastTerm <= lastLogTerm
    if (allowVote && notOutdated) {
      return this.state.setTermAndVote(term, peer.id).then(() => {
        if (this.destroyed) return

        // Give the candidate a chance to win the election.
        this.skipNextElection = true

        peer.send({
          type: GrantVote,
          term: this.state.currentTerm
        })
      })
    } else if (term > this.state.currentTerm) {
      // Update the current term if the candidate's is newer, even if no vote
      // was granted them.
      return this.state.setTerm(term)
    }
  }

  handleAppendEntries (peer, { term, prevLogIndex, prevLogTerm, entries, leaderCommit }) {
    // Reject the entries if they're part of an older term. The peer has already
    // been deposed as leader but it just doesn't know it yet. Let it know by
    // sending the current term in the reply.
    if (term < this.state.currentTerm) {
      peer.send({
        type: RejectEntries,
        term: this.state.currentTerm
      })
      return
    }

    // Verify the first entry received can safely be appended to the log. There
    // must not be any gaps. An index of 0 implies that the leader is sending
    // its first entry so there won't be any gaps.
    if (prevLogIndex > 0) {
      const prevEntry = this.log.getEntry(prevLogIndex)
      if (!prevEntry || prevEntry.term !== prevLogTerm) {
        peer.send({
          type: RejectEntries,
          term: this.state.currentTerm,
          // Include the index of the conflicting entry. Otherwise, since
          // communication is based on message passing, the leader can't tell
          // which index was rejected.
          conflictingIndex: prevLogIndex
        })
        return
      }
    }

    // Avoid accidentally deposing the leader.
    this.skipNextElection = true

    // Merge any entries into the log.
    let pending = this.log.mergeEntries(entries)
    // Update the current term if the leader's newer.
    if (term > this.state.currentTerm) {
      pending = Promise.all([pending, this.state.setTerm(term)])
    }

    // Commit the same entries as the leader.
    if (leaderCommit > this.commitIndex) {
      this.log.commit(leaderCommit)
      this.commitIndex = leaderCommit
    }

    return pending.then(() => {
      if (this.destroyed) return

      peer.send({
        type: AcceptEntries,
        term: this.state.currentTerm,
        // Include the index of the last entry that was appended to the log.
        // Otherwise, since communication is based on message passing, the
        // leader can't tell which entries were accepted.
        //
        // As an extra benefit this allows the transport to deliver fewer
        // entries than the leader attempted to send.
        lastLogIndex: this.log.lastIndex
      })
    })
  }
}