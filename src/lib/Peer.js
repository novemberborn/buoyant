import MessageBuffer from './MessageBuffer'

// Wraps the stream provided by `transport.connect()`. Represents a peer in the
// cluster.
export default class Peer {
  constructor (address, stream) {
    this.address = address
    this.stream = stream

    this.id = address.serverId
    this.messages = new MessageBuffer(stream)
  }

  send (message) {
    this.stream.write(message)
  }
}
