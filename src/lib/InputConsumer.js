// Consume messages from each peer and finally the `nonPeerReceiver`. Messages
// are passed to `handleMessage()`, via the `scheduler`, with the `peer` as the
// first argument and the message as the second.
//
// If `handleMessage()` returns a value it is assumed to be a promise. Reading
// halts until that promise is fulfilled. Rejection errors are passed to
// `crashHandler` and halt consumption indefinitely.
//
// If no peer, or the `nonPeerReceiver`, has any buffered messages, consumption
// halts until a message becomes available.
//
// If a message is received from `nonPeerReceiver` a peer is created before it
// and the message are passed to `handleMessage()`.
//
// An initial peer and message may be provided as the first argument (as an
// array).
export default class InputConsumer {
  constructor ({
    initial = null,
    peers,
    nonPeerReceiver,
    scheduler,
    handleMessage,
    crashHandler
  }) {
    this.peers = peers
    this.nonPeerReceiver = nonPeerReceiver
    this.scheduler = scheduler
    this.handleMessage = handleMessage
    this.crashHandler = crashHandler

    this.buffers = [nonPeerReceiver.messages].concat(peers.map(peer => peer.messages))
    this.halted = false

    this._crash = this.crash.bind(this)

    const promise = initial && scheduler.asap(null, handleMessage, ...initial)
    ;(promise || Promise.resolve()).then(() => this.consumeNext()).catch(this._crash)
  }

  halt () {
    this.halted = true
  }

  crash (err) {
    this.halt()
    this.crashHandler(err)
  }

  consumeNext (startIndex = 0) {
    // Consume as many messages from each peer as synchronously possible, then
    // wait for more.
    //
    // Note that synchronous message handling may halt consumption as a
    // side-effect. Each time a message is handled `this.halted` must be
    // checked.

    let resumeIndex = 0
    let pending = null

    let index = startIndex
    let repeat = true
    while (!this.halted && repeat && !pending) {
      repeat = false

      do {
        const peer = this.peers[index]
        index = (index + 1) % this.peers.length

        if (peer.messages.canTake()) {
          repeat = true

          // Only take the message when the scheduler runs the function, rather
          // than passing it as an argument to `scheduler.asap()`. If the
          // scheduler is aborted, e.g. due to a role change, the next role
          // should be able to take the message instead.
          pending = this.scheduler.asap(null, () => this.handleMessage(peer, peer.messages.take()))

          // When the next message is consumed, after the pending promise is
          // fulfilled, start with the next peer to prevent starving it.
          if (pending) {
            resumeIndex = index
          }
        }
      } while (!this.halted && !pending && index !== startIndex)
    }

    // Consume as many non-peer messages as synchronously possible.
    while (!this.halted && !pending && this.nonPeerReceiver.messages.canTake()) {
      pending = this.scheduler.asap(null, () => this.handleNonPeerMessage(...this.nonPeerReceiver.messages.take()))
    }

    if (!this.halted) {
      // Wait for new messages to become available.
      if (!pending) {
        pending = Promise.race(this.buffers.map(messages => messages.await()))
      }

      pending.then(() => this.consumeNext(resumeIndex)).catch(this._crash)
    }
  }

  handleNonPeerMessage (address, message) {
    return this.nonPeerReceiver.createPeer(address).then(peer => {
      if (this.halted) return

      this.handleMessage(peer, message)
    })
  }
}
