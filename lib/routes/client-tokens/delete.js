/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const db = require('../../db');
const authBearer = require('../../auth_bearer');

module.exports = {
  handler: function activeServices(req, reply) {
    var clientId = req.params.client_id;

    return authBearer(req)
      .then(function (credentials) {
        return db.deleteActiveClientTokens(clientId, credentials.user)
      })
      .done(reply, reply);
  }
};
