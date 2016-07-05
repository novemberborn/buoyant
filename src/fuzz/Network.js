import Entry from '../lib/Entry'
import {
  AppendEntries,
  AcceptEntries,
  RejectEntries,
  RequestVote,
  DenyVote,
  GrantVote,
  Noop
} from '../lib/symbols'

import pickRandom from './pick-random'

class Node {
  constructor (address) {
    Object.assign(this, { address })

    this.partitionId = 0
    this.streams = new Map()
  }
}

const TypeSerialization = {
  [AppendEntries]: 'AppendEntries',
  [AcceptEntries]: 'AcceptEntries',
  [RejectEntries]: 'RejectEntries',
  [RequestVote]: 'RequestVote',
  [DenyVote]: 'DenyVote',
  [GrantVote]: 'GrantVote',
  [Noop]: 'Noop'
}

const TypeDeserialization = {
  AppendEntries,
  AcceptEntries,
  RejectEntries,
  RequestVote,
  DenyVote,
  GrantVote,
  Noop
}

function serialize (message) {
  const { entries, type } = message
  const shallow = Object.assign({}, message, { type: TypeSerialization[type] })
  if (type === AppendEntries) {
    shallow.entries = entries.map(({ index, term, value }) => {
      if (value === Noop) {
        return { index, noop: true, term }
      }
      return { index, term, value }
    })
  }
  return shallow
}

function deserialize (obj) {
  const { entries, type } = obj
  const message = Object.assign({}, obj, { type: TypeDeserialization[type] })
  if (message.type === AppendEntries) {
    message.entries = entries.map(({ index, noop, term, value }) => {
      if (noop) {
        return new Entry(index, term, Noop)
      }
      return new Entry(index, term, value)
    })
  }
  return message
}

export default class Network {
  constructor ({ enqueueDelivery, getSimulation, reporter }) {
    Object.assign(this, { enqueueDelivery, getSimulation, reporter })

    this.nodes = new Map()
  }

  createTransport (serverAddress) {
    const node = new Node(serverAddress)
    this.nodes.set(serverAddress, node)

    const network = this
    const simulation = this.getSimulation(serverAddress)
    return {
      listen () {
        // Mimick a stream for messages from outside of the cluster, which
        // aren't yet supported by the fuzzer.
        return {
          once () {},
          read () { return null }
        }
      },

      connect ({ address: peerAddress, writeOnly = false }) {
        // Implement the minimal stream interface required by the message
        // buffer.
        const messages = []
        let onReadable = null
        const stream = {
          once (_, cb) {
            onReadable = cb
          },

          read () {
            return messages.shift() || null
          },

          write (message) {
            const delivery = network.enqueueDelivery(peerAddress, serverAddress, simulation.currentTime, serialize(message))
            network.reporter.sendMessage(simulation, peerAddress, delivery)
          },

          push (message) {
            messages.push(message)
            if (onReadable) {
              onReadable()
              onReadable = null
            }
          }
        }

        if (!writeOnly) {
          node.streams.set(peerAddress, stream)
        }

        return stream
      },

      destroy () {
        network.nodes.delete(serverAddress)
      }
    }
  }

  getPartitions () {
    const map = new Map()
    for (const node of this.nodes.values()) {
      const { partitionId } = node
      if (!map.has(partitionId)) {
        map.set(partitionId, [node])
      } else {
        map.get(partitionId).push(node)
      }
    }
    return Array.from(map.values())
  }

  partition () {
    const partitions = this.getPartitions()
    const partitionable = partitions.filter(nodes => nodes.length > 1)
    if (partitionable.length === 0) return

    const maxPartitionId = partitions.reduce((id, [{ partitionId }]) => Math.max(id, partitionId), 0)
    const nodes = pickRandom(partitionable)
    const node = pickRandom(nodes)
    node.partitionId = maxPartitionId + 1

    this.reporter.partition(this.getPartitions())
  }

  undoPartition () {
    const partitions = this.getPartitions()
    if (partitions.length <= 1) return

    const from = pickRandom(partitions)
    const node = pickRandom(from)
    const [{ partitionId }] = pickRandom(partitions.filter(nodes => nodes !== from))
    node.partitionId = partitionId

    this.reporter.undoPartition(this.getPartitions())
  }

  deliver (receiver, delivery) {
    const { message, sender } = delivery
    const receiverNode = this.nodes.get(receiver)
    if (!receiverNode.streams.has(sender)) throw new Error(`No connection from ${sender} to receiver ${receiver}`)

    // FIXME: Perhaps store the sender's partitionId when the delivery is
    // enqueued? That way it can delivered if the receiver is still in the same
    // partition even if the sender has since been destroyed.
    const senderNode = this.nodes.get(sender)
    if (!senderNode || !receiverNode) return

    // Drop message if nodes are in different partitions
    if (receiverNode.partitionId !== senderNode.partitionId) return

    this.reporter.receiveMessage(this.getSimulation(receiver), delivery)

    const stream = receiverNode.streams.get(sender)
    stream.push(deserialize(message))
  }
}
