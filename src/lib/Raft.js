import Candidate from './roles/Candidate'
import Follower from './roles/Follower'
import Leader from './roles/Leader'

import Log from './Log'
import LogEntryApplier from './LogEntryApplier'
import State from './State'
import Timers from './Timers'

import NonPeerReceiver from './NonPeerReceiver'
import Peer from './Peer'

function intInRange (range) {
  const [min, max] = range
  const diff = max - min
  return (Math.random() * diff >> 0) + min
}

// Implements Raft-compliant behavior.
export default class Raft {
  constructor ({
    applyEntry,
    crashHandler,
    electionTimeoutWindow,
    emitEvent,
    heartbeatInterval,
    id,
    persistEntries,
    persistState
  }) {
    this.crashHandler = crashHandler
    this.electionTimeout = intInRange(electionTimeoutWindow)
    this.emitEvent = emitEvent
    this.heartbeatInterval = heartbeatInterval
    this.id = id

    this.log = new Log({
      applier: new LogEntryApplier({ applyEntry, crashHandler }),
      persistEntries
    })
    this.state = new State(persistState)

    this.currentRole = null
    this.nonPeerReceiver = null
    this.peers = null

    this.timers = new Timers()
  }

  replaceState (state) {
    this.state.replace(state)
  }

  replaceLog (entries, lastApplied) {
    this.log.replace(entries, lastApplied)
  }

  close () {
    if (this.currentRole) {
      this.currentRole.destroy()
      this.currentRole = null
    }

    return this.log.close()
  }

  destroy () {
    if (this.currentRole) {
      this.currentRole.destroy()
      this.currentRole = null
    }

    return this.log.destroy()
  }

  async joinInitialCluster ({ addresses, connect, nonPeerStream }) {
    let failed = false

    // Attempt to connect to each address in the cluster and instantiate a peer
    // when successful. Let errors propagate to the server, which should in turn
    // destroy the transport before attempting to rejoin.
    const connectingPeers = addresses.map(async address => {
      const stream = await connect({ address })

      // Don't instantiate peers after errors have occured
      if (failed) return

      return new Peer(address, stream)
    })

    try {
      const peers = await Promise.all(connectingPeers)
      // Create a receiver for the non-peer stream, through which messages can
      // be received from other servers that are not yet in the cluster. These
      // must still be handled.
      this.nonPeerReceiver = new NonPeerReceiver(nonPeerStream, connect)
      // Set the initial peers if all managed to connect.
      this.peers = peers
      // Now enter the initial follower state.
      this.convertToFollower()
    } catch (err) {
      failed = true
      throw err
    }
  }

  becomeLeader () {
    if (this.currentRole) {
      this.currentRole.destroy()
    }

    const { crashHandler, heartbeatInterval, log, nonPeerReceiver, peers, state, timers } = this
    const role = this.currentRole = new Leader({
      convertToCandidate: this.convertToCandidate.bind(this),
      convertToFollower: this.convertToFollower.bind(this),
      crashHandler,
      heartbeatInterval,
      log,
      nonPeerReceiver,
      peers,
      state,
      timers
    })
    this.currentRole.start()

    // Only emit the event if the leader role is still active. It is possible
    // for it to synchronously consume a message that causes it to become a
    // follower, or to crash, causing the role to be destroyed before the event
    // can be emitted.
    if (this.currentRole === role) {
      this.emitEvent('leader', this.state.currentTerm)
    }
  }

  convertToCandidate () {
    if (this.currentRole) {
      this.currentRole.destroy()
    }

    const { crashHandler, electionTimeout, id: ourId, log, nonPeerReceiver, peers, state, timers } = this
    const role = this.currentRole = new Candidate({
      becomeLeader: this.becomeLeader.bind(this),
      convertToFollower: this.convertToFollower.bind(this),
      crashHandler,
      electionTimeout,
      log,
      nonPeerReceiver,
      ourId,
      peers,
      state,
      timers
    })
    this.currentRole.start()

    // Only emit the event if the candidate role is still active. It is possible
    // for it to crash, causing the role to be destroyed before the event can be
    // emitted.
    if (this.currentRole === role) {
      this.emitEvent('candidate', this.state.currentTerm)
    }
  }

  convertToFollower (replayMessage) {
    if (this.currentRole) {
      this.currentRole.destroy()
    }

    const { crashHandler, electionTimeout, log, nonPeerReceiver, peers, state, timers } = this
    const role = this.currentRole = new Follower({
      convertToCandidate: this.convertToCandidate.bind(this),
      crashHandler,
      electionTimeout,
      log,
      nonPeerReceiver,
      peers,
      state,
      timers
    })
    // The server can convert to follower state based on an incoming message.
    // Pass the message along so the follower can "replay" it.
    this.currentRole.start(replayMessage)

    // Only emit the event if the follower role is still active. It is possible
    // for it to crash, causing the role to be destroyed before the event can be
    // emitted.
    if (this.currentRole === role) {
      this.emitEvent('follower', this.state.currentTerm)
    }
  }

  append (value) {
    if (!this.currentRole || !this.currentRole.append) {
      return Promise.reject(new Error('Not leader'))
    }

    return this.currentRole.append(value)
  }
}
