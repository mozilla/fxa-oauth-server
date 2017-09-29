/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const AppError = require('../../error');
const db = require('../../db');
const logger = require('../../logging')('routes.key_data');
const P = require('../../promise');
const validators = require('../../validators');
const verify = require('../../browserid');

const STATIC_EPOCH_ACCESS_KEY = Buffer.alloc(32).toString('hex');

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
    schema: {
      identifier: Joi.string().required(),
      epochAccessKey: Joi.string().required(),
      timestamp: Joi.number().required()
    }
  },
  handler: function keyDataRoute(req, reply) {
    const requestedScope = req.payload.scope;
    const requestedClientId = req.params.client_id;

    logger.debug('start', {
      params: req.params,
      payload: req.payload
    });

    P.all([
      verify(req.payload.assertion).then((claims) => {
        if (! claims) {
          throw AppError.invalidAssertion();
        }
        return claims;
      }),
      db.getClient(Buffer.from(requestedClientId, 'hex')).then((client) => {
        if (client && client.allowedScopes) {
          return db.getScope(requestedScope).then((scopeDetails) => {
            if (! scopeDetails) {
              logger.info('keyDataRoute.noScope', {
                requestedScope: requestedScope
              });

              throw AppError.invalidScopes(requestedScope);
            }

            if (! scopeDetails.hasScopedKeys) {
              // limit the key-data endpoint to clients that can only provide scoped key functionality
              logger.info('keyDataRoute.nohasScopedKeys', {
                requestedScope: requestedScope,
                clientId: requestedClientId
              });

              throw AppError.invalidScopes(requestedScope);
            }

            const clientScopes = client.allowedScopes.split(/\s+/g);

            if (! clientScopes.includes(requestedScope)) {
              // if the requested scoped is not supported by this client
              logger.info('keyDataRoute.unsupportedScope', {
                requestedScope: requestedScope,
                clientScopes: clientScopes,
                clientId: requestedClientId
              });

              throw AppError.invalidScopes(requestedScope);
            }

            return {
              client: client,
              scopeDetails: scopeDetails
            };
          });
        } else {
          logger.info('invalid scopeDetails or client', {
            clientId: requestedClientId,
            requestedScope: requestedScope
          });

          throw AppError.invalidScopes(requestedScope);
        }
      })
    ]).then((results => {
      logger.debug('results', JSON.stringify(results));
      const assertionData = results[0];
      const clientData = results[1];
      const scopeDetails = clientData.scopeDetails;

      return {
        identifier: scopeDetails.scope,
        epochAccessKey: STATIC_EPOCH_ACCESS_KEY,
        timestamp: assertionData['fxa-generation']
      };
    })).done(reply, reply);

  }
};
