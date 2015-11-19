import { before, beforeEach, describe, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import sinon from 'sinon'

describe('Peer', () => {
  before(ctx => {
    ctx.MessageBuffer = sinon.stub()
    ctx.Peer = proxyquire.noCallThru()('../lib/Peer', {
      './MessageBuffer': function (...args) { return ctx.MessageBuffer(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.MessageBuffer.reset()

    ctx.stream = sinon.stub({ read () {}, write () {} })
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
      sinon.assert.calledOnce(ctx.MessageBuffer)
      sinon.assert.calledWithExactly(ctx.MessageBuffer, ctx.stream)
      assert(peer.messages === messages)
    })
  })

  describe('#send (message)', () => {
    it('writes the message to the stream', ctx => {
      const message = Symbol()
      const peer = new ctx.Peer({}, ctx.stream)
      peer.send(message)

      sinon.assert.calledOnce(ctx.stream.write)
      sinon.assert.calledWithExactly(ctx.stream.write, message)
    })
  })
})
