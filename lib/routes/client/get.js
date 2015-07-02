/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const hex = require('buf').to.hex;
const Joi = require('joi');

const AppError = require('../../error');
const db = require('../../db');
const logger = require('../../logging')('routes.client.get');
const validators = require('../../validators');

module.exports = {
  validate: {
    params: {
      client_id: validators.clientId
    }
  },
  response: {
    schema: {
      id: validators.clientId,
      name: Joi.string().required(),
      trusted: Joi.boolean().required(),
      canSso: Joi.boolean(),
      image_uri: Joi.any(),
      redirect_uri: Joi.string().required().allow(''),
      terms_uri: Joi.string().required().allow(''),
      privacy_uri: Joi.string().required().allow('')
    }
  },
  handler: function requestInfoEndpoint(req, reply) {
    var params = req.params;
    db.getClient(Buffer(params.client_id, 'hex')).then(function(client) {
      if (!client) {
        logger.debug('notFound', { id: params.client_id });
        throw AppError.unknownClient(params.client_id);
      }
      return client;
    }).done(function(client) {
      reply({
        id: hex(client.id),
        name: client.name,
        trusted: client.trusted,
        canSso: client.canSso,
        image_uri: client.imageUri,
        redirect_uri: client.redirectUri,
        terms_uri: client.termsUri,
        privacy_uri: client.privacyUri
      });
    }, reply);
  }
};
