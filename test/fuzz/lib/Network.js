import { Duplex, Readable } from 'stream'

const NonPeer = { [Symbol.for('Non-peer address')]: true }

export default class Network {
  constructor ({ getProcess }) {
    this._getProcess = getProcess

    this._counter = 0
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
      connect: ({ address: peerAddress, readWrite = true, writeOnly = false }) => {
        let stream = byOrigin.get(peerAddress)
        if (!stream) {
          if (readWrite) {
            stream = new Duplex({
              objectMode: true,
              read () {},
              write: (message, _, done) => {
                this.enqueue(serverAddress, peerAddress, message)
                done()
              }
            })

            byOrigin.set(peerAddress, stream)
          } else if (writeOnly) {
            stream = new Readable({ objectMode: true, read () {} })
          }
        }

        return stream
      },
      destroy: () => this._streams.delete(serverAddress)
    }
  }

  enqueue (sender, receiver, message) {
    this._queue.push({
      delivered: 0,
      id: this._counter++,
      message,
      receiver,
      sender,
      timestamp: this._getProcess(sender).currentTime
    })
  }

  hasQueued () {
    return this._queue.length > 0
  }

  dequeue () {
    if (!this.hasQueued()) return null

    const entry = this._queue.shift()
    return Object.assign({
      deliver: () => {
        const byOrigin = this._streams.get(entry.receiver)
        if (!byOrigin) return false

        const stream = byOrigin.get(entry.sender)
        if (!stream) return false

        stream.push(entry.message)
        entry.delivered++
        return true
      },
      requeue: () => {
        const position = this._queue[Math.floor(Math.random() * this._queue.length)]
        this._queue.splice(position, 0, entry)
      }
    }, entry)
  }
}
