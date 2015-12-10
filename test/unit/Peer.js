import { before, beforeEach, describe, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from '!proxyquire'
import { stub } from 'sinon'

describe('Peer', () => {
  before(ctx => {
    ctx.MessageBuffer = stub()
    ctx.Peer = proxyquire('lib/Peer', {
      './MessageBuffer': function (...args) { return ctx.MessageBuffer(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.MessageBuffer.reset()

    ctx.stream = stub({ read () {}, write () {} })
  })

  describe('constructor (address, stream)', () => {
    it('sets address on the instance', ctx => {
      const address = Symbol()
      assert(new ctx.Peer(address, ctx.stream).address === address)
    })

    it('sets the address’ serverId on the instance, as id', ctx => {
      const serverId = Symbol()
      assert(new ctx.Peer({ serverId }, ctx.stream).id === serverId)
    })

    it('creates a MessageBuffer instance for the stream', ctx => {
      const messages = {}
      ctx.MessageBuffer.returns(messages)

      const peer = new ctx.Peer({}, ctx.stream)
      assert(ctx.MessageBuffer.calledOnce)
      const { args: [stream] } = ctx.MessageBuffer.firstCall
      assert(stream === ctx.stream)
      assert(peer.messages === messages)
    })
  })

  describe('#send (message)', () => {
    it('writes the message to the stream', ctx => {
      const message = Symbol()
      const peer = new ctx.Peer({}, ctx.stream)
      peer.send(message)

      assert(ctx.stream.write.calledOnce)
      const { args: [written] } = ctx.stream.write.firstCall
      assert(written === message)
    })
  })
})
