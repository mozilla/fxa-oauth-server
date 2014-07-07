/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const db = require('../lib/db');
const config = require('../lib/config').root();
const assert = require('insist');
const crypto = require('crypto');

/*global describe,it*/

function randomString(len) {
  return crypto.randomBytes(Math.ceil(len)).toString('hex');
}

describe('db', function() {

  describe('#_initialClients', function() {
    it('should not insert already existing clients', function() {
      return db.ping().then(function() {
        return db._initialClients();
      });
    });
  });

  describe('utf-8', function() {

    function makeTest(clientId, clientName) {
      return function() {
        var data = {
          id: clientId,
          name: clientName,
          secret: randomString(32),
          imageUri: 'https://example.domain/logo',
          redirectUri: 'https://example.domain/return?foo=bar',
          whitelisted: true
        };

        return db.registerClient(data)
          .then(function(c) {
            assert.equal(c.id.toString('hex'), clientId);
            assert.equal(c.name, clientName);
            return db.getClient(c.id);
          })
          .then(function(cli) {
            assert.equal(cli.id.toString('hex'), clientId);
            assert.equal(cli.name, clientName);
            return db.removeClient(clientId);
          })
          .then(function() {
            return db.getClient(clientId)
              .then(function(cli) {
                assert.equal(void 0, cli);
              });
          });
      };
    }

    it('2-byte encoding preserved', makeTest(randomString(8), 'Düsseldorf'));
    it('3-byte encoding preserved', makeTest(randomString(8), '北京')); // Beijing
    // U+1D6D1 MATHEMATICAL BOLD SMALL PI
    it('4-byte encoding preserved', makeTest(randomString(8), '𝛑'));


  });

  describe('getEncodingInfo', function() {
    it('should use utf8mb4', function() {
      if (config.db.driver === 'memory') {
        return assert.ok('getEncodingInfo has no meaning with memory impl');
      }

      return db.getEncodingInfo()
        .then(function(info) {
          /*jshint sub:true*/
          assert.equal(info['character_set_connection'], 'utf8mb4');
          // travis-ci doesn't support mysql 5.6 yet, so dumb down this check slightly
          assert.equal(info['character_set_database'].indexOf('utf8'), 0);
          assert.equal(info['collation_connection'], 'utf8mb4_unicode_ci');
          assert.equal(info['collation_database'], 'utf8mb4_unicode_ci');
        });
    });
  });

});
