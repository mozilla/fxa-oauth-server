/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const hex = require('buf').to.hex;

const config = require('../../config');
const localizeTimestamp = require('fxa-shared').l10n.localizeTimestamp({
  supportedLanguages: config.get('i18n.supportedLanguages'),
  defaultLanguage: config.get('i18n.defaultLanguage')
});

const db = require('../../db');
const authBearer = require('../../auth_bearer');

function serialize(client, acceptLanguage) {
  var lastAccessTime = client.createdAt.getTime();
  var lastAccessTimeFormatted = localizeTimestamp.format(lastAccessTime, acceptLanguage);

  return {
    name: client.name,
    id: hex(client.id),
    lastAccessTime: lastAccessTime,
    lastAccessTimeFormatted: lastAccessTimeFormatted
  };
}

module.exports = {
  handler: function activeServices(req, reply) {
    return authBearer(req)
      .then(function (credentials) {
        return db.getActiveClientTokensByUid(credentials.user);
      })
      .done(function(clients) {
        reply(clients.map(function(client) {
          return serialize(client, req.headers['accept-language'])
        }));
      }, reply);
  }
};
