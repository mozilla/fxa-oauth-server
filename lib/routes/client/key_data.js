/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Joi = require('joi');

const AppError = require('../../error');
const config = require('../config');
const db = require('../../db');
const logger = require('../../logging')('routes.key_data');
const P = require('../../promise');
const validators = require('../../validators');
const verify = require('../../browserid');

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
      keyDescription: Joi.string().required(),
      keyIdentifier: Joi.string().required(),
      keySalt: Joi.string().required(),
      keyTimestamp: Joi.number().required()
    }
  },
  handler: function keyDataRoute(req, reply) {
    const scope = req.payload.scope;
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
      db.getClient(Buffer.from(req.params.client_id, 'hex')).then((client) => {
        if (client && client.applicationScope) {
          return db.getApplicationScope(client.applicationScope).then((appScope) => {
            const scopesArr = scope.split(/\s+/g);
            if (! appScope) {
              throw new Error('No such app scope');
            } else if (scopesArr.includes(appScope.applicationScope)) {
              return {
                client: client,
                appScope: appScope
              }
            } else {
              throw new Error('Scopes do not match');
            }
          });
        } else {
          logger.info('invalid appScope or client', {
            clientId: req.params.client_id,
            scope: scope
          });
          throw AppError.invalidScopes(scope);
        }
      })
    ]).then((results => {
      logger.debug('results', JSON.stringify(results));
      const assertionData = results[0];
      const clientData = results[1];
      const appScope = clientData.appScope;

      return {
        keyIdentifier: appScope.applicationScope,
        keySalt: appScope.salt.toString('hex'),
        keyDescription: appScope.description,
        keyTimestamp: assertionData['fxa-generation']
      };
    })).done(reply, reply);

  }
};
