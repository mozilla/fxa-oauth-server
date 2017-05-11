/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const db = require('../db');

module.exports = {
  auth: {
    strategy: 'authBearer',
    scope: ['profile']
  },
  handler: function activeServices(req, reply) {
    // TODO: look up by access token
    // TODO: make /keys single use

    return db.getDerivedKey(req.auth.credentials.user + req.auth.credentials.client_id)
      .then(function (result) {

        return result;
      })
      .then(reply,reply)
  }
};
