/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const buf = require('buf').hex;
const hex = require('buf').to.hex;
const Joi = require('joi');
const URI = require('URIjs');

const AppError = require('../error');
const config = require('../config');
const db = require('../db');
const logger = require('../logging')('routes.authorization');
const activityEvent = require('../logging/activity-event');
const P = require('../promise');
const Scope = require('../scope');
const validators = require('../validators');
const verify = require('../browserid');

const CODE = 'code';
const TOKEN = 'token';

const ACCESS_TYPE_ONLINE = 'online';
const ACCESS_TYPE_OFFLINE = 'offline';


const UNTRUSTED_CLIENT_ALLOWED_SCOPES = [
  'profile:uid',
  'profile:email',
  'profile:display_name'
];

function isLocalHost(url) {
  var host = new URI(url).hostname();
  return host === 'localhost' || host === '127.0.0.1';
}

function detectInvalidScopes(requestedScopes, validScopes) {
  var invalidScopes = [];

  requestedScopes.forEach(function(scope) {
    if (validScopes.indexOf(scope) === -1) {
      invalidScopes.push(scope);
    }
  });

  return invalidScopes;
}

function generateCode(claims, client, scope, req) {
  return db.generateCode({
    clientId: client.id,
    userId: buf(claims.uid),
    email: claims['fxa-verifiedEmail'],
    scope: scope,
    authAt: claims['fxa-lastAuthAt'],
    offline: req.payload.access_type === ACCESS_TYPE_OFFLINE
  }).then(function(code) {
    logger.debug('redirecting', { uri: req.payload.redirect_uri });

    var redirect = URI(req.payload.redirect_uri)
      .addQuery({ state: req.payload.state, code: hex(code) });


    var out = { redirect: String(redirect) };
    logger.info('generateCode', {
      request: {
        client_id: req.payload.client_id,
        redirect_uri: req.payload.redirect_uri,
        scope: req.payload.scope,
        state: req.payload.state,
        response_type: req.payload.response_type
      },
      response: out
    });
    return out;
  });
}

function generateGrant(claims, client, scope, req) {
  return db.generateAccessToken({
    clientId: client.id,
    userId: buf(claims.uid),
    email: claims['fxa-verifiedEmail'],
    scope: scope
  }).then(function(token) {
    return {
      access_token: hex(token.token),
      token_type: 'bearer',
      expires_in: Math.floor((token.expiresAt - Date.now()) / 1000),
      scope: scope.join(' '),
      auth_at: claims['fxa-lastAuthAt']
    };
  });
}

module.exports = {
  validate: {
    payload: {
      client_id: validators.clientId,
      assertion: Joi.string()
        // taken from mozilla/persona/lib/validate.js
        .min(50)
        .max(10240)
        .regex(/^[a-zA-Z0-9_\-\.~=]+$/)
        .required(),
      redirect_uri: Joi.string()
        .max(256),
      scope: Joi.string()
        .max(256),
      response_type: Joi.string()
        .valid(CODE, TOKEN)
        .default(CODE),
      state: Joi.string()
        .max(256)
        .when('response_type', {
          is: TOKEN,
          then: Joi.optional(),
          otherwise: Joi.required()
        }),
      access_type: Joi.string()
        .valid(ACCESS_TYPE_OFFLINE, ACCESS_TYPE_ONLINE)
        .default(ACCESS_TYPE_ONLINE)
        .optional(),
    }
  },
  response: {
    schema: Joi.object().keys({
      redirect: Joi.string(),
      access_token: validators.token,
      token_type: Joi.string().valid('bearer'),
      scope: Joi.string(),
      auth_at: Joi.number(),
      expires_in: Joi.number()
    }).without('redirect', [
      'access_token'
    ]).with('access_token', [
      'token_type',
      'scope',
      'auth_at',
      'expires_in'
    ])
  },
  handler: function authorizationEndpoint(req, reply) {
    logger.debug('response_type', req.payload.response_type);
    var start = Date.now();
    var wantsGrant = req.payload.response_type === TOKEN;
    var exitEarly = false;
    var scope = Scope(req.payload.scope || []);
    P.all([
      verify(req.payload.assertion).then(function(claims) {
        logger.info('time.browserid_verify', { ms: Date.now() - start });
        if (!claims) {
          exitEarly = true;
          throw AppError.invalidAssertion();
        }
        activityEvent('authorizedRelier', claims.uid, req.payload.client_id, req);
        return claims;
      }),
      db.getClient(Buffer(req.payload.client_id, 'hex')).then(function(client) {
        logger.info('time.db_get_client', { ms: Date.now() - start });
        if (exitEarly) {
          // assertion was invalid, we can just stop here
          return;
        }
        if (!client) {
          logger.debug('notFound', { id: req.payload.client_id });
          throw AppError.unknownClient(req.payload.client_id);
        } else if (!client.trusted) {
          var invalidScopes = detectInvalidScopes(scope.values(),
                                UNTRUSTED_CLIENT_ALLOWED_SCOPES);

          if (invalidScopes.length) {
            throw AppError.invalidScopes(invalidScopes);
          }
        }

        var uri = req.payload.redirect_uri || client.redirectUri;

        if (uri !== client.redirectUri) {
          logger.debug('redirect.mismatch', {
            param: uri,
            registered: client.redirectUri
          });

          if (config.get('localRedirects') && isLocalHost(uri)) {
            logger.debug('redirect.local', { uri: uri });
          } else {
            throw AppError.incorrectRedirect(uri);
          }

        }

        if (wantsGrant && !client.canGrant) {
          logger.warn('implicitGrant.notAllowed', {
            id: req.payload.client_id
          });
          throw AppError.invalidResponseType();
        }

        req.payload.redirect_uri = uri;

        return client;
      }),
      scope.values(),
      req
    ])
    .spread(wantsGrant ? generateGrant : generateCode)
    .done(reply, reply);
  }
};
