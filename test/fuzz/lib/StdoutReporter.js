import { Writable } from 'stream'
import { inspect } from 'util'

import chalk from 'chalk'

export default class StdoutReporter extends Writable {
  constructor (options) {
    super(Object.assign({}, options, { objectMode: true }))
  }

  _write (record, _, callback) {
    const chunk = this.format(record)
    if (process.stdout.write(chunk)) {
      callback()
    } else {
      process.stdout.once('drain', callback)
    }
  }

  format (record) {
    const { address, timestamp, type } = record
    if (!address) {
      throw new Error(`Missing address for record of type: ${type}`)
    }
    if (!timestamp) {
      throw new Error(`Missing timestamp for record of type: ${type}`)
    }
    if (!type) {
      throw new Error('Missing type for record')
    }

    const parts = []
    parts.push(chalk.green(`[${this.formatTimestamp(timestamp)} ${address.serverId}]`))
    parts.push(' ', chalk.magenta(type))

    switch (type) {
      case 'receiveMessage':
        const { deliveries, id, payload, queued, sender, sentAt } = record
        parts.push(' id=', this.formatValue(id))
        parts.push(' deliveries=', this.formatValue(deliveries))
        parts.push(' queued=', this.formatValue(queued))
        parts.push(' sender=', chalk.green(sender.serverId))
        parts.push(' sentAt=', this.formatTimestamp(sentAt))
        parts.push('\n↳ ', this.formatValue(payload).replace(/^(\s\s)/gm, '$1$1'))
        break

      default:
        for (const prop in record) {
          if (prop === 'address' || prop === 'type' || prop === 'timestamp') {
            continue
          }

          parts.push(' ', prop, '=', this.formatValue(record[prop]))
        }
    }

    return new Buffer(`${parts.join('')}\n`)
  }

  formatTimestamp ({ sinceEpoch, vector }) {
    return chalk.cyan(`${sinceEpoch}ms/${vector}v`)
  }

  formatValue (value) {
    return inspect(value, { colors: true, depth: null })
  }
}
