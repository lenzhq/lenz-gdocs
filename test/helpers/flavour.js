// Test-only: what a built flavour adds to src/. The suites that load src/ straight into a vm run this
// config.js first (the one dist/<flavour>/config.js holds), read through scripts/build.js, so no test
// hard-codes a client id. The internal flavour's real config/flavours/internal.json is not in git, so
// the suites read test/fixtures/flavours/internal.json (made-up values, the same manifest) instead.
'use strict';
const path = require('node:path');
const { configJs, loadFlavour } = require('../../scripts/build.js');

const INTERNAL_FIXTURE = path.join(__dirname, '..', 'fixtures', 'flavours', 'internal.json');

/** build() / loadFlavour() options that point a flavour at its test config. */
function flavourFile(flavour) {
  return flavour === 'internal' ? INTERNAL_FIXTURE : undefined;
}

function flavourConfig(flavour) {
  flavour = flavour || 'internal';
  return loadFlavour(flavour, undefined, flavourFile(flavour));
}

function configSource(flavour) {
  flavour = flavour || 'internal';
  return configJs(flavour, flavourConfig(flavour));
}

module.exports = { flavourConfig, configSource, flavourFile, INTERNAL_FIXTURE,
  INTERNAL_CLIENT_ID: flavourConfig('internal').oauthClientId };
