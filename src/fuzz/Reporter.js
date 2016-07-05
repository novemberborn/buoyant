import { inspect } from 'util'

import { Noop } from '../lib/symbols'

import {
  ApplyEntry,
  PersistEntries,
  PersistState
} from './QueueManager'

const CallTypeSerialization = {
  [ApplyEntry]: 'applyEntry',
  [PersistEntries]: 'persistEntries',
  [PersistState]: 'persistState'
}

export default class Reporter {
  constructor ({ colors = true, json = false }) {
    Object.assign(this, { colors, json })
  }

  write (record) {
    if (this.json) {
      console.log(JSON.stringify(record))
    } else {
      console.log(inspect(record, { colors: this.colors, depth: null }))
    }
  }

  async observeRun (promise) {
    try {
      await promise
      this.write({ complete: true })
    } catch (err) {
      this.write(Object.assign({ failed: true }, this.serializeError(err)))
      console.error(err && err.stack || err)
      process.exitCode = 1
    }
  }

  unhandledRejection (err) {
    this.write(Object.assign({ unhandledRejection: true }, this.serializeError(err)))
    console.error(err && err.stack || err)
    process.exitCode = 1
  }

  serializeError (err) {
    if (!err) return { err }

    const result = {}
    const { message, stack } = err
    if (message) result.message = message
    if (stack) result.stack = stack
    return Object.assign(result, err)
  }

  serializePartitions (partitions) {
    return partitions.reduce((byId, nodes) => {
      const [{ partitionId: id }] = nodes
      byId[id] = nodes.map(({ address: { serverId } }) => serverId)
      return byId
    }, {})
  }

  serializeCall ({ args, id, queued, timestamp, type }) {
    const result = {
      queuedAt: timestamp,
      callId: id,
      callType: CallTypeSerialization[type]
    }
    if (queued > 1) {
      result.requeueCount = queued - 1
    }

    switch (type) {
      case ApplyEntry: {
        const [{ index, term, value }] = args
        if (value === Noop) {
          result.entry = { index, term, noop: true }
        } else {
          result.entry = { index, term, value }
        }
        break
      }

      case PersistEntries: {
        const [entries] = args
        result.entries = entries.map(({ index, term, value }) => {
          if (value === Noop) {
            return { index, term, noop: true }
          }
          return { index, term, value }
        })
        break
      }

      case PersistState: {
        const [{ currentTerm, votedFor }] = args
        Object.assign(result, { currentTerm, votedFor })
        break
      }
    }

    return result
  }

  serializeDelivery ({ id, message, queued, timestamp, type }) {
    const result = {
      queuedAt: timestamp,
      messageId: id,
      message
    }
    if (queued > 1) {
      result.requeueCount = queued - 1
    }
    return result
  }

  advanceClock ({ address, currentTime, nextTime }) {
    this.write({
      cause: 'advanceClock',
      serverId: address.serverId,
      serverTime: currentTime,
      nextTime
    })
  }

  append ({ address, currentTime }, value) {
    this.write({
      cause: 'append',
      serverId: address.serverId,
      serverTime: currentTime,
      value
    })
  }

  applyEntry ({ address, currentTime }, call) {
    this.write(Object.assign({
      effect: 'applyEntry',
      serverId: address.serverId,
      serverTime: currentTime
    }, this.serializeCall(call)))
  }

  becameCandidate ({ address, currentTime }) {
    this.write({
      effect: 'becameCandidate',
      serverId: address.serverId,
      serverTime: currentTime
    })
  }

  becameFollower ({ address, currentTime }) {
    this.write({
      effect: 'becameFollower',
      serverId: address.serverId,
      serverTime: currentTime
    })
  }

  becameLeader ({ address, currentTime }, term) {
    this.write({
      effect: 'becameLeader',
      serverId: address.serverId,
      serverTime: currentTime,
      term
    })
  }

  commit ({ address, currentTime }, sum) {
    this.write({
      effect: 'commit',
      serverId: address.serverId,
      serverTime: currentTime,
      sum
    })
  }

  crash ({ address, currentTime }, err) {
    this.write({
      effect: 'crash',
      serverId: address.serverId,
      serverTime: currentTime,
      err: this.serializeError(err)
    })
  }

  createServer (address, heartbeatInterval, electionTimeout) {
    this.write({
      cause: 'createServer',
      serverId: address.serverId,
      heartbeatInterval,
      electionTimeout
    })
  }

  dropMessage ({ address, currentTime }, delivery) {
    const { sender } = delivery
    this.write(Object.assign({
      cause: 'dropMessage',
      serverId: address.serverId,
      serverTime: currentTime,
      senderId: sender.serverId
    }, this.serializeDelivery(delivery)))
  }

  failCall ({ address, currentTime }, call) {
    this.write(Object.assign({
      cause: 'failCall',
      serverId: address.serverId,
      serverTime: currentTime
    }, this.serializeCall(call)))
  }

  intentionalCrash ({ address, currentTime }) {
    this.write(Object.assign({
      effect: 'intentionalCrash',
      serverId: address.serverId,
      serverTime: currentTime
    }))
  }

  kill ({ address, currentTime }) {
    this.write({
      cause: 'kill',
      serverId: address.serverId,
      serverTime: currentTime
    })
  }

  killAfterCrash ({ address, currentTime }) {
    this.write({
      effect: 'killAfterCrash',
      serverId: address.serverId,
      serverTime: currentTime
    })
  }

  noCommit ({ address, currentTime }, value) {
    this.write({
      effect: 'noCommit',
      serverId: address.serverId,
      serverTime: currentTime,
      value
    })
  }

  partition (partitions) {
    this.write({
      cause: 'partition',
      partitions: this.serializePartitions(partitions)
    })
  }

  persistEntries ({ address, currentTime }, call) {
    this.write(Object.assign({
      effect: 'persistEntries',
      serverId: address.serverId,
      serverTime: currentTime
    }, this.serializeCall(call)))
  }

  persistState ({ address, currentTime }, call) {
    this.write(Object.assign({
      effect: 'persistState',
      serverId: address.serverId,
      serverTime: currentTime
    }, this.serializeCall(call)))
  }

  receiveMessage ({ address, currentTime }, delivery) {
    const { sender } = delivery
    this.write(Object.assign({
      effect: 'receiveMessage',
      serverId: address.serverId,
      serverTime: currentTime,
      senderId: sender.serverId
    }, this.serializeDelivery(delivery)))
  }

  restartServer (address, heartbeatInterval, electionTimeout) {
    this.write({
      cause: 'restartServer',
      serverId: address.serverId,
      heartbeatInterval,
      electionTimeout
    })
  }

  requeue ({ address, currentTime }, delivery) {
    const { sender } = delivery
    this.write(Object.assign({
      cause: 'requeue',
      serverId: address.serverId,
      serverTime: currentTime,
      senderId: sender.serverId
    }, this.serializeDelivery(delivery)))
  }

  sendMessage ({ address, currentTime }, receiver, delivery) {
    this.write(Object.assign({
      cause: 'sendMessage',
      serverId: address.serverId,
      serverTime: currentTime,
      receiverId: receiver.serverId
    }, this.serializeDelivery(delivery)))
  }

  undoPartition (partitions) {
    this.write({
      cause: 'undoPartition',
      partitions: this.serializePartitions(partitions)
    })
  }
}
