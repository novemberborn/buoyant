import exposeEvents from './expose-events'
import Address from './Address'
import Raft from './Raft'

// Implements a server that uses the Raft Consensus Algorithm. Provides the
// public interface for interacting with the cluster.
export default class Server {
  constructor ({
    address,
    applyEntry,
    crashHandler,
    createTransport,
    electionTimeoutWindow,
    heartbeatInterval,
    id,
    persistEntries,
    persistState
  }) {
    const emitter = exposeEvents(this)

    const raft = new Raft({
      applyEntry,
      crashHandler,
      electionTimeoutWindow,
      emitEvent: emitter.emit.bind(emitter),
      heartbeatInterval,
      id,
      persistEntries,
      persistState
    })

    Object.defineProperties(this, {
      address: { value: address, enumerable: true },
      id: { value: id, enumerable: true },

      _createTransport: { value: createTransport },
      _raft: { value: raft },
      _allowJoin: { value: true, writable: true },
      _allowRestore: { value: true, writable: true },
      _closeInProgress: { value: null, writable: true },
      _transport: { value: null, writable: true }
    })
  }

  // Restore persistent server state prior to joining a cluster.
  restoreState (state) {
    if (!this._allowRestore) {
      throw new Error('Restoring state is no longer allowed')
    }

    this._raft.replaceState(state)
  }

  // Restore the log and the index of the entry that was last applied to the
  // state machine, prior to joining a cluster.
  restoreLog (entries, lastApplied) {
    if (!this._allowRestore) {
      throw new Error('Restoring log is no longer allowed')
    }

    this._raft.replaceLog(entries, lastApplied)
  }

  // Gracefully stop the Raft implementation, allowing it to finish applying
  // entries to the state machine. The transport is destroyed right away since
  // no new messages should be sent or received.
  close () {
    if (!this._closeInProgress) {
      this._allowJoin = false

      const transport = this._transport
      this._transport = null

      this._closeInProgress = Promise.all([
        transport && new Promise(resolve => resolve(transport.destroy())),
        this._raft.close()
      ]).then(() => undefined)
    }

    return this._closeInProgress
  }

  // Ungracefully destroy the Raft implementation and the transport.
  destroy () {
    this._allowJoin = false

    const transport = this._transport
    this._transport = null

    this._closeInProgress = Promise.all([
      transport && new Promise(resolve => resolve(transport.destroy())),
      this._raft.destroy()
    ]).then(() => undefined)

    return this._closeInProgress
  }

  // Join a cluster.
  join (addresses = []) {
    return new Promise(resolve => {
      addresses = Array.from(addresses, item => {
        return Address.is(item) ? item : new Address(item)
      })

      if (!this._allowJoin) {
        if (this._closeInProgress) {
          throw new Error('Server is closed')
        }
        throw new Error('Joining a cluster is no longer allowed')
      }

      this._allowJoin = false
      this._allowRestore = false

      // Try joining the cluster. If errors occur try to close the transport and
      // cleanup, then rethrow the original error. This should allow the calling
      // code to retry, especially if the error came from the provided
      // transport.
      this._transport = this._createTransport(this.address)
      const joining = new Promise(resolve => resolve(this._transport.listen()))
        .then(nonPeerStream => {
          return this._raft.joinInitialCluster({
            addresses,
            connect: opts => {
              return new Promise(resolve => resolve(this._transport.connect(opts)))
            },
            nonPeerStream
          })
        })
        .catch(err => {
          if (this._closeInProgress) {
            throw err
          }

          this._allowJoin = true
          this._allowRestore = true

          const rethrow = () => { throw err }
          return new Promise(resolve => {
            const transport = this._transport
            this._transport = null
            resolve(transport.destroy())
          }).then(rethrow, rethrow)
        })

      resolve(joining)
    })
  }

  // Append a value to the state machine, once it's been sufficiently replicated
  // within the Raft cluster, and only if this server is the leader.
  append (value) {
    return this._raft.append(value)
  }
}
