/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const auth = require('../../auth');
const db = require('../../db');
const hex = require('buf').to.hex;
const token = require('../../token');

function serialize(service) {
  return {
    name: service.name,
    id: hex(service.id),
    scope: service.name
  };
}

module.exports = {
  handler: function activeServices(req, reply) {
    // TODO: quick hacks
    var t = req.headers.authorization.substring(7);
    var serviceId = req.path.substring(13);
    return token.verify(t)
      .then(function(tokenData) {
          if (tokenData.email) {
            return db.deleteTokensByService(serviceId)
          }
        }
      )
      .done(reply, reply);
  }
};
