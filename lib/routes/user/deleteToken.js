/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const auth = require('../../auth');
const AppError = require('../../error');
const db = require('../../db');
const encrypt = require('../../encrypt');
const unbuf = require('buf').unbuf.hex;
const validators = require('../../validators');

/*jshint camelcase: false*/

module.exports = {
  auth: {
    strategy: auth.AUTH_STRATEGY,
    scope: [auth.SCOPE_CLIENT_MANAGEMENT, auth.SCOPE_TOKEN_MANAGEMENT]
  },
  validate: {
    params: {
      token_id: Joi.string()
        .length(encrypt.getHashSize() * 2) // hex = bytes*2
        .regex(validators.HEX_STRING)
        .required()
    }
  },
  handler: function deleteTokenId(req, reply) {
    db.getToken(req.params.token_id)
    .then(function(tok) {
      if (!tok) {
        throw AppError.invalidToken();
      }
      var token = tok.token;
      return db.removeToken(unbuf(token));
    }).done(function() {
      reply().code(204);
    }, reply);
  }
};
