/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const AppError = require('../error');
const db = require('../db');

const HEX_STRING = /^[0-9a-f]+$/;

module.exports = {
  validate: {
    payload: {
      pubkey: Joi.string()
        .length(32 * 2)
        .regex(HEX_STRING),
      token: Joi.string()
        .length(32 * 2)
        .regex(HEX_STRING)
    }
  },
  response: {
    schema: {
      user: Joi.string().required(),
      scope: Joi.array(),
      email: Joi.string()
    }
  },
  handler: function verify(req, reply) {
    var method;
    var token;
    if (req.payload.pubkey) {
      method = 'getPubKey';
      token = req.payload.pubkey;
    } else if (req.payload.token) {
      method = 'getToken';
      token = req.payload.token;
    } else {
      reply(AppError.invalidRequestParameter('pubkey or token required'));
    }
    db[method](Buffer(token, 'hex'))
    .then(function(key) {
      if (!key) {
        throw AppError.invalidToken();
      }
      var blob = {
        user: key.userId.toString('hex'),
        scope: key.scope
      };

      // token.scope is a Set/Array
      if (key.scope.indexOf('profile') !== -1) {
        blob.email = key.email;
      }

      return blob;
    }).done(reply, reply);
  }
};
