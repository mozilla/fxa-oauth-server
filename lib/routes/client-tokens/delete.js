/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const db = require('../../db');

module.exports = {
  auth: {
    mode: 'required'
  },
  handler: function activeServices(req, reply) {
    var clientId = req.params.client_id;
    var uid = req.auth.credentials.user;
    return db.deleteActiveClientTokens(clientId, uid)
      .done(reply, reply);
  }
};
