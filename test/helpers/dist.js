const { join } = require('path')

module.exports = mid => join(__dirname, '..', '..', 'dist', mid)
