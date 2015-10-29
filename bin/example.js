'use strict'

const path = require('path')

const babel = require('babel-core')
const sourceMapSupport = require('source-map-support')

// Resolve the example location relative to the current working directory.
const mod = path.resolve('example', process.argv[2])

// Fix up argv so the example thinks it was invoked directly. Note that we're
// not fixing other properties like execArgv.
process.argv = ['node', mod].concat(process.argv.slice(3))

// Cache source maps for the example modules that were transformed on the fly.
const transformMaps = Object.create(null)

// Hook up source map support to rewrite stack traces. Use our cached source
// maps but fall back to retrieving them from the pragma in the source file. The
// latter will work for `npm run build` output.
sourceMapSupport.install({
  environment: 'node',
  handleUncaughtExceptions: false,
  retrieveSourceMap (source) {
    return transformMaps[source] || sourceMapSupport.retrieveSourceMap(source)
  }
})

// Only modules in the example dir are transformed. All other modules are
// assumed to be compatible. This means the examples run with the build code
// as it's distributed on npm.
const exampleDir = path.dirname(mod)
const requirePlain = require.extensions['.js']
require.extensions['.js'] = function (module, filename) {
  if (!filename.startsWith(exampleDir + '/')) {
    requirePlain(module, filename)
    return
  }

  const result = babel.transformFileSync(filename, {
    sourceMap: 'both',
    ast: false
  })

  transformMaps[filename] = { url: filename, map: result.map }
  module._compile(result.code, filename)
}

// Now load the example.
require(mod)
