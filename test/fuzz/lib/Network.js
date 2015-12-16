import { Duplex, Readable } from 'stream'

const NonPeer = { [Symbol('Non-peer address')]: true }

export default class Network {
  constructor ({ getProcess }) {
    this._getProcess = getProcess

    this._messageCount = 0
    this._streams = new Map()
    this._queue = []
  }

  createTransport (serverAddress) {
    const byOrigin = new Map()
    this._streams.set(serverAddress, byOrigin)

    const nonPeerStream = new Readable({ objectMode: true, read () {} })
    byOrigin.set(NonPeer, nonPeerStream)

    return {
      listen: () => nonPeerStream,
      connect: ({ address: peerAddress, writeOnly = false }) => {
        if (byOrigin.has(peerAddress)) return byOrigin.get(peerAddress)

        const stream = new Duplex({
          objectMode: true,
          read () {},
          write: (message, _, done) => {
            this.enqueue(serverAddress, peerAddress, message)
            done()
          }
        })
        if (!writeOnly) {
          byOrigin.set(peerAddress, stream)
        }
        return stream
      },
      destroy: () => this._streams.delete(serverAddress)
    }
  }

  enqueue (sender, receiver, payload) {
    this._queue.push({
      deliveries: 0,
      id: this._messageCount++,
      payload,
      queued: 1,
      receiver,
      sender,
      timestamp: this._getProcess(sender).currentTime
    })
  }

  dequeue () {
    if (!this.hasQueued()) return null

    const item = this._queue.shift()
    const { receiver, sender, payload } = item
    return Object.assign({
      deliver: () => {
        const byOrigin = this._streams.get(receiver)
        if (!byOrigin) return false

        const stream = byOrigin.get(sender)
        if (!stream) return false

        item.deliveries++
        stream.push(payload)
        return true
      },
      requeue: (position = Math.floor(Math.random() * (this._queue.length + 1))) => {
        item.queued++
        this._queue.splice(position, 0, item)
      }
    }, item)
  }

  hasQueued () {
    return this._queue.length > 0
  }
}
