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
export default class InputConsumer {
  constructor ({
    crashHandler,
    handleMessage,
    nonPeerReceiver,
    peers,
    scheduler
  }) {
    this.crashHandler = crashHandler
    this.handleMessage = handleMessage
    this.nonPeerReceiver = nonPeerReceiver
    this.peers = peers
    this.scheduler = scheduler

    this.buffers = [nonPeerReceiver.messages].concat(peers.map(peer => peer.messages))
    this.stopped = false
  }

  start () {
    try {
      this.consumeNext()
    } catch (err) {
      this.crash(err)
    }
  }

  stop () {
    this.stopped = true
  }

  crash (err) {
    this.stop()
    this.crashHandler(err)
  }

  consumeNext (startIndex = 0) {
    // Consume as many messages from each peer as synchronously possible, then
    // wait for more.
    //
    // Note that synchronous message handling may stop consumption as a
    // side-effect. Each time a message is handled `this.stopped` must be
    // checked.

    let resumeIndex = 0
    let pending = null

    let index = startIndex
    let repeat = true
    while (!this.stopped && repeat && !pending) {
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
      } while (!this.stopped && !pending && index !== startIndex)
    }

    // Consume the next non-peer message, if available.
    if (!this.stopped && !pending && this.nonPeerReceiver.messages.canTake()) {
      pending = this.scheduler.asap(null, () => this.handleNonPeerMessage(...this.nonPeerReceiver.messages.take()))
    }

    if (!this.stopped) {
      // Wait for new messages to become available.
      if (!pending) {
        pending = Promise.race(this.buffers.map(messages => messages.await()))
      }

      pending.then(() => this.consumeNext(resumeIndex)).catch(err => this.crash(err))
    }
  }

  handleNonPeerMessage (address, message) {
    return this.nonPeerReceiver.createPeer(address).then(peer => {
      if (this.stopped) return

      return this.handleMessage(peer, message)
    })
  }
}
