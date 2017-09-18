/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const assert = require('insist');
const proxyquire = require('proxyquire');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');


const db = require('../lib/db');
const P = require('../lib/promise');

const UID = crypto.randomBytes(16).toString('hex');

const mockDb = {
  revokePublicTokens: sinon.stub()
};

describe('events', function() {
  describe('onResetOrPasswordChange', () => {
    it('calls db on passwordChange', (done) => {
      const ev = proxyquire('../lib/events', {
        './db': mockDb
      });

      function Message(type, onDel) {
        return {
          event: type,
          uid: UID,
          del: onDel
        };
      }

      ev.onData(new Message('passwordChange', () => {
        var revokeCall = mockDb.revokePublicTokens;
        assert.ok(revokeCall.calledOnce);
        assert.equal(revokeCall.args[0][0].length, 32, 'called with uid');
        done();
      }));

    });

  });
});
