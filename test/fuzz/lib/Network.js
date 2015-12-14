import { Duplex, Readable } from 'stream'

const NonPeer = { [Symbol.for('Non-peer address')]: true }

export default class Network {
  constructor () {
    this.streams = new Map()
    this.buffer = []
  }

  createTransport (serverAddress) {
    const byOrigin = new Map()
    this.streams.set(serverAddress, byOrigin)

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
              write (message, _, done) {
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
      destroy: () => this.streams.delete(serverAddress)
    }
  }

  enqueue (sender, receiver, message) {
    this.buffer.push([sender, receiver, message])
  }

  dequeue () {
    if (this.buffer.length === 0) return null

    const [sender, receiver, message] = this.buffer.shift()
    return {
      requeue: () => {
        const position = this.buffer[Math.floor(Math.random() * this.buffer.length)]
        this.buffer.splice(position, 0, [sender, receiver, message])
      },
      deliver: () => {
        const byOrigin = this.streams.get(receiver)
        if (!byOrigin) return false

        const stream = byOrigin.get(sender)
        if (!stream) return false

        stream.push(message)
        return true
      }
    }
  }
}
