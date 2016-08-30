/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const db = require('../../db');

module.exports = {
  auth: {
    strategy: 'authBearer'
  },
  handler: function activeServices(req, reply) {
    var clientId = req.params.client_id;
    return db.deleteActiveClientTokens(clientId, req.auth.credentials.user)
      .done(reply, reply);
  }
};
