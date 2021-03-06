'use strict'

const path = require('path')

const babel = require('babel-core')
const sourceMapSupport = require('source-map-support')

// Resolve the example location relative to the current working directory.
const mod = path.resolve('example', process.argv[2])

// Fix up argv so the example thinks it was invoked directly. Don't fix other
// properties like execArgv.
process.argv = ['node', mod].concat(process.argv.slice(3))

// Cache source maps for the example modules that were transformed on the fly.
const transformMaps = Object.create(null)

// Hook up source map support to rewrite stack traces. Use cached source maps
// but fall back to retrieving them from the pragma in the source file. The
// latter will work for `npm run build` output.
sourceMapSupport.install({
  environment: 'node',
  handleUncaughtExceptions: false,
  retrieveSourceMap (source) {
    return transformMaps[source]
  }
})

// Only modules in the example dir are transformed. All other modules are
// assumed to be compatible. This means the examples run with the build code
// as it's distributed on npm.
const exampleDir = path.dirname(mod) + '/'
require('pirates').addHook(function (code, filename) {
  const result = babel.transform(code, Object.assign({
    ast: false,
    filename,
    sourceMap: true
  }))
  transformMaps[filename] = { url: filename, map: result.map }
  return result.code
}, {
  matcher: filename => filename.startsWith(exampleDir)
})

// Now load the example.
require(mod)
