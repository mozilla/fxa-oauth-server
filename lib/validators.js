/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const config = require('./config');

exports.HEX_STRING = /^(?:[0-9a-f]{2})+$/;

exports.clientId = Joi.string()
  .length(config.get('unique.id') * 2) // hex = bytes*2
  .regex(exports.HEX_STRING)
  .required();

exports.clientSecret = Joi.string()
  .length(config.get('unique.clientSecret') * 2) // hex = bytes*2
  .regex(exports.HEX_STRING)
  .required();

exports.codeVerifier = Joi.string()
  .length(32); // https://tools.ietf.org/html/rfc7636#section-4.1

exports.token = Joi.string()
  .length(config.get('unique.token') * 2)
  .regex(exports.HEX_STRING);

exports.scope = Joi.string()
  .max(256);

// taken from mozilla/persona/lib/validate.js
exports.assertion = Joi.string()
  .min(50)
  .max(10240)
  .regex(/^[a-zA-Z0-9_\-\.~=]+$/);

