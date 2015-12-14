'use strict'

const path = require('path')

// Cache source maps for the test modules that were transformed on the fly.
const transformMaps = Object.create(null)

// Hook up source map support to rewrite stack traces. Use cached source maps
// but fall back to retrieving them from the pragma in the source file. The
// latter will work for `npm run build` output.
const sourceMapSupport = require('source-map-support')
sourceMapSupport.install({
  environment: 'node',
  handleUncaughtExceptions: false,
  retrieveSourceMap (source) {
    return transformMaps[source]
  }
})

// Rewrite paths starting with `🏠/`, as well as the `🏠` path, to the package
// root.
const homeDir = path.resolve(__dirname, '..', '..')
// Resolve the `!mocha` source to the wrapper module.
const mochaWrapperSource = path.join(__dirname, 'mocha-wrapper.js')
// Resolve the `!proxyquire` source to the wrapper module.
const proxyquireWrapperSource = path.join(__dirname, 'proxyquire-wrapper.js')
function resolveModuleSource (source, filename) {
  if (source.startsWith('🏠/') || source === '🏠') {
    return path.join(homeDir, source.slice(3)) // 2 bytes for the 🏠 character!
  } else if (source === '!mocha') {
    return mochaWrapperSource
  } else if (source === '!proxyquire') {
    return proxyquireWrapperSource
  } else {
    return source
  }
}

const babel = require('babel-core')
// Only modules in the test dir are transformed. All other modules are
// assumed to be compatible. This means the examples run with the build code
// as it's distributed on npm.
const testDir = path.resolve(__dirname, '..') + '/'
require('pirates').addHook(function (code, filename) {
  const result = babel.transform(code, {
    ast: false,
    filename,
    plugins: ['babel-plugin-espower', 'transform-async-to-generator'],
    resolveModuleSource,
    sourceMap: true
  })
  transformMaps[filename] = { url: filename, map: result.map }
  return result.code
}, {
  matcher: filename => filename.startsWith(testDir)
})
