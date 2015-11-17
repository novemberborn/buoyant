import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote,
  Noop
} from '../symbols'

import InputConsumer from '../InputConsumer'
import Scheduler from '../Scheduler'

const handlerMap = Object.create(null, {
  [RequestVote]: { value: 'handleRequestVote' },
  [RejectEntries]: { value: 'handleRejectEntries' },
  [AcceptEntries]: { value: 'handleAcceptEntries' }
})

// Implements leader behavior according to Raft.
export default class Leader {
  constructor ({
    heartbeatInterval,
    state,
    log,
    peers,
    nonPeerReceiver,
    crashHandler,
    convertToCandidate,
    convertToFollower
  }) {
    this.heartbeatInterval = heartbeatInterval
    this.state = state
    this.log = log
    this.peers = peers
    this.convertToCandidate = convertToCandidate
    this.convertToFollower = convertToFollower

    this.destroyed = false
    this.commitIndex = 0
    this.pendingApplication = []

    // Track Raft's `nextIndex` and `matchIndex` values for each peer.
    this.peerState = peers.reduce((map, peer) => {
      return map.set(peer, {
        nextIndex: log.lastIndex + 1,
        matchIndex: 0
      })
    }, new Map())
    this.skipNextHeartbeat = false
    this.timer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval)

    this.scheduler = new Scheduler(crashHandler)
    this.inputConsumer = new InputConsumer({
      peers,
      nonPeerReceiver,
      scheduler: this.scheduler,
      handleMessage: this.handleMessage.bind(this),
      crashHandler
    })

    // Claim leadership by appending a no-op entry. Committing that entry also
    // causes any uncommitted entries from previous terms to be committed.
    this.append(Noop)

    this.inputConsumer.start()
  }

  destroy () {
    this.destroyed = true
    clearInterval(this.timer)
    this.inputConsumer.stop()
    this.scheduler.abort()
    for (const { reject } of this.pendingApplication) {
      reject(new Error('No longer leader'))
    }
    this.pendingApplication = []
  }

  sendHeartbeat () {
    // Heartbeats are sent on an interval rather than a timer that is restarted.
    // This should be more efficient. A flag is set after all followers are
    // updated with an actual entry to avoid sending an unnecessary heartbeat.
    if (this.skipNextHeartbeat) {
      this.skipNextHeartbeat = false
      return
    }

    // Don't use the scheduler here as it's OK to send heartbeats with stale
    // data. This should prevent the leader from being deposed if persistence
    // operations are taking longer than the election timeouts of the followers.
    //
    // (Of course if an operation is stuck then the cluster will no longer make
    // progress. The cluster will also fail to make progress if half of the
    // followers are stuck. The program that uses Buoyant is expected to fail
    // its persistence operation if it can't complete in a reasonable amount of
    // time.)
    for (const [peer, state] of this.peerState) {
      this.updateFollower(peer, state, true)
    }
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
    // Deny the vote if it's for an older term. Send the current term in the
    // reply so the candidate can update itself.
    if (term < this.state.currentTerm) {
      peer.send({
        type: DenyVote,
        term: this.state.currentTerm
      })
      return
    }

    // The leader can ignore vote requests for the current term. Send a
    // heartbeat instead, provided the peer is in the cluster.
    if (this.peerState.has(peer)) {
      this.updateFollower(peer, this.peerState.get(peer), true)
    }
  }

  handleRejectEntries (peer, term, { conflictingIndex }) {
    // Discard messages from servers not in the cluster.
    if (!this.peerState.has(peer)) return

    // See if the follower is lagging. Don't let stale replies impact
    // convergence with the follower.
    const state = this.peerState.get(peer)
    if (conflictingIndex > state.matchIndex && conflictingIndex < state.nextIndex) {
      state.nextIndex = conflictingIndex
      this.updateFollower(peer, state, true)
    }
  }

  handleAcceptEntries (peer, term, { lastLogIndex }) {
    // Discard messages from servers not in the cluster.
    if (!this.peerState.has(peer)) return

    // The follower's log has converged. Advance its nextIndex and matchIndex
    // state if any entries have been accepted. Mark any replication that has
    // occurred. Finally see if there are any new entries that need to be sent.
    const state = this.peerState.get(peer)
    if (lastLogIndex >= state.nextIndex) {
      this.markReplication(state.nextIndex, lastLogIndex)
      state.nextIndex = lastLogIndex + 1
      state.matchIndex = lastLogIndex
    }

    if (state.nextIndex <= this.log.lastIndex) {
      this.updateFollower(peer, state, false)
    }
  }

  markReplication (startIndex, endIndex) {
    // Mark entries within the range as having been replicated to another
    // follower. Note that the follower's identity is irrelevant. The logic in
    // `handleAcceptEntries()` prevents double-counting replication to a
    // particular follower.
    for (const state of this.pendingApplication) {
      if (state.index > endIndex) {
        break
      }

      // Decrement the counter if the entry was replicated to this follower.
      if (state.index >= startIndex) {
        state.acceptsRequired--
      }
    }

    // Apply each entry that is sufficiently replicated. Assume the log
    // takes care of applying one entry at a time, and applying entries from
    // previous terms if necessary.
    while (this.pendingApplication.length > 0 && this.pendingApplication[0].acceptsRequired === 0) {
      const { index, resolve } = this.pendingApplication.shift()

      // Update the commit index. The entry will be applied in the background.
      this.commitIndex = index
      resolve(this.log.commit(index))
    }
  }

  append (value) {
    return new Promise((resolve, reject) => {
      this.scheduler.asap(
        () => reject(new Error('Aborted')),
        () => this.log.appendValue(this.state.currentTerm, value).then(entry => {
          if (this.destroyed) {
            reject(new Error('No longer leader'))
            return
          }

          this.pendingApplication.push({
            index: entry.index,
            // The entry must be replicated to the majority of the cluster. It's
            // already been persisted by the leader, so at least half of the
            // remaining peers need to accept it.
            acceptsRequired: Math.ceil(this.peers.length / 2),
            resolve,
            reject
          })

          for (const [peer, state] of this.peerState) {
            this.updateFollower(peer, state, false)
          }
          this.skipNextHeartbeat = true
        }))
    })
  }

  updateFollower (peer, { nextIndex, matchIndex }, heartbeatOnly) {
    const prevLogIndex = nextIndex - 1

    // Send a heartbeat so the logs can converge if the follower is behind.
    if (prevLogIndex !== matchIndex) {
      heartbeatOnly = true
    }

    peer.send({
      type: AppendEntries,
      term: this.state.currentTerm,
      prevLogIndex: prevLogIndex,
      prevLogTerm: this.log.getTerm(prevLogIndex),
      leaderCommit: this.commitIndex,
      // TODO: Avoid repeatedly sending the same entry if the follower is slow,
      // find a way to back-off the retransmissions.
      entries: heartbeatOnly ? [] : this.log.getEntriesSince(nextIndex)
    })
  }
}
