import { before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import sinon from 'sinon'

import { getReason } from './support/utils'

describe('NonPeerReceiver', () => {
  before(ctx => {
    ctx.MessageBuffer = sinon.stub()
    ctx.Peer = sinon.stub()
    ctx.NonPeerReceiver = proxyquire.noCallThru()('../lib/NonPeerReceiver', {
      './MessageBuffer': function (...args) { return ctx.MessageBuffer(...args) },
      './Peer': function (...args) { return ctx.Peer(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.MessageBuffer.reset()
    ctx.Peer.reset()

    ctx.stream = sinon.stub({ read () {} })
    ctx.connect = sinon.stub().returns(new Promise(() => {}))
  })

  describe('constructor (stream, connect)', () => {
    it('creates a message buffer for the stream', ctx => {
      const messages = {}
      ctx.MessageBuffer.returns(messages)

      const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
      sinon.assert.calledOnce(ctx.MessageBuffer)
      sinon.assert.calledWithExactly(ctx.MessageBuffer, ctx.stream)
      assert(receiver.messages === messages)
    })
  })

  describe('#createPeer (address)', ctx => {
    it('connects to the address', ctx => {
      const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
      const peerAddress = Symbol()
      receiver.createPeer(peerAddress)

      sinon.assert.calledOnce(ctx.connect)
      const { args: [{ address, writeOnly }] } = ctx.connect.getCall(0)
      assert(address === peerAddress)
      assert(writeOnly === true)
    })

    context('connecting succeeds', () => {
      it('returns a promise fulfilled with the peer', async ctx => {
        const peerAddress = Symbol()
        const stream = {}
        ctx.connect.returns(Promise.resolve(stream))

        const peer = {}
        ctx.Peer.returns(peer)

        const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
        assert(await receiver.createPeer(peerAddress) === peer)
        sinon.assert.calledWithExactly(ctx.Peer, peerAddress, stream)
      })
    })

    context('connecting fails', () => {
      it('returns a promise rejected with the failure', async ctx => {
        const err = Symbol()
        ctx.connect.returns(Promise.reject(err))

        const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
        assert(await getReason(receiver.createPeer()) === err)
      })
    })
  })
})
