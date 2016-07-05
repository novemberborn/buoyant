export const ApplyEntry = Symbol('ApplyEntry')
export const PersistEntries = Symbol('PersistEntries')
export const PersistState = Symbol('PersistState')

export default class QueueManager {
  constructor () {
    this.idCount = 0
    this.queuesByAddress = new Map()
  }

  getQueues (address) {
    if (!this.queuesByAddress.has(address)) {
      this.queuesByAddress.set(address, {
        calls: [],
        deliveries: []
      })
    }

    return this.queuesByAddress.get(address)
  }

  enqueue (queue, item) {
    Object.assign(item, { id: this.idCount++, queued: 1 })
    item.promise = new Promise((resolve, reject) => {
      Object.assign(item, { resolve, reject })
    })

    queue.push(item)
    return item
  }

  enqueueCall (address, type, timestamp, args) {
    const { calls: queue } = this.getQueues(address)
    return this.enqueue(queue, {
      args,
      timestamp,
      type
    })
  }

  enqueueDelivery (address, sender, timestamp, message) {
    const { deliveries: queue } = this.getQueues(address)
    return this.enqueue(queue, {
      message,
      sender,
      timestamp
    })
  }

  dequeue (queue) {
    if (queue.length === 0) return null

    const item = queue.shift()
    return Object.assign({
      requeue: (position = Math.floor(Math.random() * (queue.length + 1))) => {
        item.queued++
        queue.splice(position, 0, item)
      }
    }, item)
  }

  dequeueCall (address) {
    const { calls: queue } = this.getQueues(address)
    return this.dequeue(queue)
  }

  dequeueDelivery (address) {
    const { deliveries: queue } = this.getQueues(address)
    return this.dequeue(queue)
  }

  hasQueuedCalls (address) {
    const { calls: queue } = this.getQueues(address)
    return queue.length > 0
  }

  hasQueuedDeliveries (address) {
    const { deliveries: queue } = this.getQueues(address)
    return queue.length > 0
  }

  delete (address) {
    this.queuesByAddress.delete(address)
  }
}
