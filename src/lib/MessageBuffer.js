// Wraps a readable stream to make it easier to see if a message can be taken
// synchronously, and to get a promise if a message needs to be waited for.
export default class MessageBuffer {
  constructor (stream) {
    this.stream = stream

    this.next = null
    this.awaiting = null
  }

  take () {
    if (this.next !== null) {
      const message = this.next
      this.next = null
      return message
    }

    return this.stream.read()
  }

  canTake () {
    if (this.next === null) {
      this.next = this.stream.read()
    }

    return this.next !== null
  }

  await () {
    if (this.awaiting) {
      return this.awaiting
    }

    this.awaiting = new Promise(resolve => {
      if (this.canTake()) {
        this.awaiting = null
        resolve()
      } else {
        this.stream.once('readable', () => {
          this.awaiting = null
          resolve()
        })
      }
    })
    return this.awaiting
  }
}
