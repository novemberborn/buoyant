import NonPeerReceiver from './NonPeerReceiver'

import Candidate from './roles/Candidate'
import Follower from './roles/Follower'
import Leader from './roles/Leader'

import Log from './Log'
import LogEntryApplier from './LogEntryApplier'
import State from './State'

import Peer from './Peer'

function intInRange (range) {
  const [min, max] = range
  const diff = max - min
  return (Math.random() * diff >> 0) + min
}

// Implements Raft-compliant behavior.
export default class Raft {
  constructor ({
    id,
    electionTimeoutWindow,
    heartbeatInterval,
    persistState,
    persistEntries,
    applyEntry,
    crashHandler,
    emitEvent
  }) {
    this.id = id
    this.electionTimeout = intInRange(electionTimeoutWindow)
    this.heartbeatInterval = heartbeatInterval

    this.state = new State(persistState)
    this.log = new Log({
      persistEntries,
      applier: new LogEntryApplier({ applyEntry, crashHandler })
    })

    this.crashHandler = crashHandler
    this.emitEvent = emitEvent

    this.peers = null
    this.nonPeerReceiver = null
    this.currentRole = null
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

  joinInitialCluster ({ addresses, connect, nonPeerStream }) {
    // Attempt to connect to each address in the cluster and instantiate a peer
    // when successful. Let errors propagate to the server, which should in turn
    // destroy the transport before attempting to rejoin.
    const connectingPeers = addresses.map(address => {
      let abort = null
      let aborted = false
      const promise = new Promise((resolve, reject) => {
        connect({ address, readWrite: true }).then(stream => {
          if (!aborted) {
            resolve(new Peer(address, stream))
          }
        }).catch(reject)
        abort = () => {
          aborted = true
          resolve(null)
        }
      })
      return [promise, abort]
    })

    return Promise.all(connectingPeers.map(([promise]) => promise)).then(peers => {
      // Create a receiver for the non-peer stream, through which messages can
      // be received from other servers that are not yet in the cluster. These
      // must still be handled.
      this.nonPeerReceiver = new NonPeerReceiver(nonPeerStream, connect)
      // Set the initial peers if all managed to connect.
      this.peers = peers
      // Now enter the initial follower state.
      this.convertToFollower()
    }).catch(err => {
      // Upon the first connection error abort any other connection attempts.
      for (const [, abort] of connectingPeers) {
        abort()
      }

      throw err
    })
  }

  becomeLeader () {
    if (this.currentRole) {
      this.currentRole.destroy()
    }

    // Emit the `leader` event now. Events are emitted asynchronously so it's
    // safe to emit before the leader role has been instantiated. In case the
    // role emits further events they'll be ordered correctly.
    this.emitEvent('leader')

    const { heartbeatInterval, state, log, peers, nonPeerReceiver, crashHandler } = this
    this.currentRole = new Leader({
      heartbeatInterval,
      state,
      log,
      peers,
      nonPeerReceiver,
      crashHandler,
      convertToCandidate: this.convertToCandidate.bind(this),
      convertToFollower: this.convertToFollower.bind(this)
    })
    this.currentRole.start()
  }

  convertToCandidate () {
    if (this.currentRole) {
      this.currentRole.destroy()
    }

    // Emit the `candidate` event now. Events are emitted asynchronously so it's
    // safe to emit before the candidate role has been instantiated. In case the
    // role emits further events they'll be ordered correctly.
    this.emitEvent('candidate')

    const { id: ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler } = this
    this.currentRole = new Candidate({
      ourId,
      electionTimeout,
      state,
      log,
      peers,
      nonPeerReceiver,
      crashHandler,
      convertToFollower: this.convertToFollower.bind(this),
      becomeLeader: this.becomeLeader.bind(this)
    })
    this.currentRole.start()
  }

  convertToFollower (replayMessage) {
    if (this.currentRole) {
      this.currentRole.destroy()
    }

    // Emit the `follower` event now. Events are emitted asynchronously so it's
    // safe to emit before the follower role has been instantiated. In case the
    // role emits further events they'll be ordered correctly.
    this.emitEvent('follower')

    const { electionTimeout, state, log, peers, nonPeerReceiver, crashHandler } = this
    this.currentRole = new Follower({
      electionTimeout,
      state,
      log,
      peers,
      nonPeerReceiver,
      crashHandler,
      convertToCandidate: this.convertToCandidate.bind(this)
    })
    // The server can convert to follower state based on an incoming message.
    // Pass the message along so the follower can "replay" it.
    this.currentRole.start(replayMessage)
  }

  append (value) {
    if (!this.currentRole.append) {
      return Promise.reject(new Error('Not leader'))
    }

    return this.currentRole.append(value)
  }
}
