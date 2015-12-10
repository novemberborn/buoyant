import { join, resolve } from 'path'

import proxyquire from 'proxyquire'

const packageRoot = resolve(__dirname, '..', '..')

export default function (request, stubs) {
  return proxyquire.noCallThru()(join(packageRoot, request), stubs)
}
