import MessageBuffer from './MessageBuffer'
import Peer from './Peer'

// Wraps the stream provided by `transport.listen()`. The `InputConsumer` takes
// a receiver instance to consume messages.
export default class NonPeerReceiver {
  constructor (stream, connect) {
    this.stream = stream
    this.connect = connect

    this.messages = new MessageBuffer(stream)
  }

  async createPeer (address) {
    const stream = await this.connect({ address, writeOnly: true })
    return new Peer(address, stream)
  }
}
