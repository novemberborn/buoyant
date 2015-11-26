#!/bin/bash
set -e

# Shell script to compute code coverage even after the Babel transforms have
# been applied. Probably doesn't work on Windows, rewriting it to pure JS should
# solve that.

# Clear previous coverage.
rm -rf coverage

# Generate test coverage based on however `npm test` performs the tests.
nyc --reporter=json npm test

# Move generated JSON file so it can be remapped and won't confuse Istanbul
# later.
mv coverage/coverage-final.json coverage/coverage.json

# Rewrite the coverage file taking the Babel source maps into account.
remap-istanbul -i coverage/coverage.json -o coverage/coverage.json

# Generate an lcov.info file and an HTML report, and output a text report.
istanbul report lcov text
