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
  auth: {
    mode: 'required'
  },
  handler: function activeServices(req, reply) {
    console.log(req.auth)
    var t = req.headers.authorization.substring(7);
    return token.verify(t)
      .then(function(tokenData) {
          return db.getActiveServicesByEmail(tokenData.email)
        }
      )
      .done(function(services) {
        reply(services.map(serialize));
      }, reply);
  }
};
