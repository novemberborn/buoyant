import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote
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
    convertToCandidate,
    convertToFollower,
    crashHandler,
    heartbeatInterval,
    log,
    nonPeerReceiver,
    peers,
    state,
    timers
  }) {
    this.convertToCandidate = convertToCandidate
    this.convertToFollower = convertToFollower
    this.heartbeatInterval = heartbeatInterval
    this.log = log
    this.peers = peers
    this.state = state
    this.timers = timers

    // Track Raft's `nextIndex` and `matchIndex` values for each peer.
    this.peerState = peers.reduce((map, peer) => {
      return map.set(peer, {
        nextIndex: log.lastIndex + 1,
        matchIndex: 0
      })
    }, new Map())

    this.commitIndex = 0
    this.destroyed = false
    this.pendingApplication = []
    this.scheduledHeartbeatHandler = false
    this.skipNextHeartbeat = false
    this.intervalObject = null

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
    this.intervalObject = this.timers.setInterval(() => this.sendHeartbeat(), this.heartbeatInterval)

    // Claim leadership by sending a heartbeat.
    this.sendHeartbeat()

    // TODO: Determine if there are uncommitted entries from previous terms. If
    // so, append a no-op entry. Once that entry is committed so will the
    // previous entries.

    // Start last so it doesn't preempt claiming leadership.
    this.inputConsumer.start()
  }

  destroy () {
    this.destroyed = true
    this.timers.clearInterval(this.intervalObject)
    this.inputConsumer.stop()
    this.scheduler.abort()
    for (const { reject } of this.pendingApplication) {
      reject(new Error('No longer leader'))
    }
    this.pendingApplication = []
  }

  sendHeartbeat () {
    // Use the scheduler to avoid interrupting an active operation. However the
    // scheduler may be blocked for longer than the heartbeat interval. Ignore
    // further invocations until the first heartbeat has been sent.
    if (this.scheduledHeartbeatHandler) return

    this.scheduledHeartbeatHandler = true
    this.scheduler.asap(null, () => {
      this.scheduledHeartbeatHandler = false

      // Heartbeats are sent using an interval rather than a timer. This should
      // be more efficient. To avoid sending unnecessary heartbeats, a flag is
      // set after all followers are updated with an actual entry.
      if (this.skipNextHeartbeat) {
        this.skipNextHeartbeat = false
        return
      }

      for (const [peer, state] of this.peerState) {
        this.updateFollower(peer, state, true)
      }
    })
  }

  handleMessage (peer, message) {
    const { type, term } = message

    // Convert to follower if the message has a newer term.
    if (term > this.state.currentTerm) {
      return this.state.setTerm(term).then(() => {
        if (this.destroyed) return

        this.convertToFollower([peer, message])
        return
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
        async () => {
          const entry = await this.log.appendValue(this.state.currentTerm, value)
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
        }
      )
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
