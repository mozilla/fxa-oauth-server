/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const auth = require('../../auth');
const db = require('../../db');
const unbuf = require('buf').unbuf.hex;
const validators = require('../../validators');

/*jshint camelcase: false*/

function serialize(token) {
  return {
    id: unbuf(token.token),
    client_id: unbuf(token.clientId),
    token_type: token.type,
    scope: token.scope.join(' '),
    created_at: +token.createdAt
  };
}

module.exports = {
  auth: {
    strategy: auth.AUTH_STRATEGY,
    scope: [auth.SCOPE_CLIENT_MANAGEMENT, auth.SCOPE_TOKEN_MANAGEMENT]
  },
  response: {
    schema: {
      tokens: Joi.array().includes(
        Joi.object().keys({
          id: Joi.string().required(),
          client_id: validators.clientId,
          token_type: Joi.string().valid('bearer').required(),
          scope: Joi.string().required().allow(''),
          created_at: Joi.number().required()
        })
      )
    }
  },
  handler: function getTokens(req, reply) {
    var userId = req.auth.credentials.user;
    db.getUserTokens(userId).done(function(tokens) {
      reply({
        tokens: tokens.map(serialize)
      });
    }, reply);
  }
};
