/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const AppError = require('../error');
const db = require('../db');
const logger = require('../logging')('routes.key_data');
const P = require('../promise');
const validators = require('../validators');
const verify = require('../browserid');
const Scope = require('../scope');

const ADDITIONAL_KEY_MATERIAL = Buffer.alloc(32).toString('hex');

module.exports = {
  validate: {
    params: {
      client_id: validators.clientId
    },
    payload: {
      assertion: validators.assertion.required(),
      scope: Joi.string()
    }
  },
  response: {
    schema: Joi.object().pattern(/^/, [
      Joi.object({
        identifier: Joi.string().required(),
        keyMaterial: Joi.string().required(),
        timestamp: Joi.number().required()
      })
    ])
  },
  handler: function keyDataRoute(req, reply) {
    logger.debug('keyDataRoute.start', {
      params: req.params,
      payload: req.payload
    });

    const requestedScopes = new Set(Scope(req.payload.scope).values());
    const requestedClientId = req.params.client_id;

    P.all([
      verify(req.payload.assertion),
      db.getClient(Buffer.from(requestedClientId, 'hex')).then((client) => {
        if (client) {
          const allowedScopes = new Set(Scope(client.allowedScopes || []).values());
          // find all requested scopes in allowed scopes
          const scopes = new Set([...allowedScopes].filter((x) => requestedScopes.has(x)));
          const scopeRequests = [];
          scopes.forEach((s) => {
            scopeRequests.push(db.getScope(s));
          });

          return P.all(scopeRequests).then((result) => {
            return result.filter((s) => !! s.hasScopedKeys);
          });
        } else {
          logger.debug('keyDataRoute.clientNotFound', { id: req.payload.client_id });
          throw AppError.unknownClient(requestedClientId);
        }
      })
    ]).then((results => {
      logger.debug('keyDataRoute.results', JSON.stringify(results));
      const assertionData = results[0];
      const scopeResults = results[1];
      const response = {};

      scopeResults.forEach((keyScope) => {
        response[keyScope.scope] = {
          identifier: keyScope.scope,
          keyMaterial: ADDITIONAL_KEY_MATERIAL,
          timestamp: assertionData['fxa-generation']
        };
      });

      return response;
    })).done(reply, reply);

  }
};
