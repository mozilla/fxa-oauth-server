/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const url = require('url');
const assert = require('insist');
const nock = require('nock');
const buf = require('buf').hex;
const generateRSAKeypair = require('keypair');
const JWTool = require('fxa-jwtool');

const auth = require('../lib/auth');
const config = require('../lib/config');
const db = require('../lib/db');
const encrypt = require('../lib/encrypt');
const P = require('../lib/promise');
const Server = require('./lib/server');
const unique = require('../lib/unique');

const assertSecurityHeaders = require('./lib/util').assertSecurityHeaders;

const USERID = unique(16).toString('hex');
const VEMAIL = unique(4).toString('hex') + '@mozilla.com';
const VERIFY_GOOD = JSON.stringify({
  status: 'okay',
  email: USERID + '@' + config.get('browserid.issuer'),
  issuer: config.get('browserid.issuer'),
  idpClaims: {
    'fxa-verifiedEmail': VEMAIL,
    'fxa-lastAuthAt': 123456
  }
});

const MAX_TTL_S = config.get('expiration.accessToken') / 1000;

const JWT_PRIV_KEY = JWTool.JWK.fromObject(require('./lib/privkey.json'));
const JWT_PUB_KEY = require('./lib/pubkey.json');
JWT_PUB_KEY.kid = 'dev-1';
JWT_PUB_KEY.use = 'sig';
JWT_PUB_KEY.alg = 'RS';


function mockAssertion() {
  var parts = url.parse(config.get('browserid.verificationUrl'));
  return nock(parts.protocol + '//' + parts.host).post(parts.path);
}

function genAssertion(email) {
  var idp = JWTool.JWK.fromPEM(
    generateRSAKeypair().private,
    { iss: config.get('browserid.issuer') });
  var userPair = generateRSAKeypair();
  var userSecret = JWTool.JWK.fromPEM(
    userPair.private,
    { iss: config.get('browserid.issuer') });
  var userPublic = JWTool.JWK.fromPEM(userPair.public);
  var now = Date.now();
  var cert = idp.signSync(
    {
      'public-key': userPublic,
      principal: {
        email: email
      },
      iat: now - 1000,
      exp: now,
      'fxa-verifiedEmail': VEMAIL
    }
  );
  var assertion = userSecret.signSync(
    {
      aud: 'oauth.fxa',
      exp: now
    }
  );

  return P.resolve(cert + '~' + assertion);
}


var client;
// this matches the hashed secret in config, an assert sanity checks
// lower to make sure it matches
var secret = 'b93ef8a8f3e553a430d7e5b904c6132b2722633af9f03128029201d24a97f2a8';
var secretPrevious = 'ec62e3281e3b56e702fe7e82ca7b1fa59d6c2a6766d6d28cccbf8bfa8d5fc8a8';
var badSecret;
var clientId;
var AN_ASSERTION;

function authParams(params) {
  var defaults = {
    assertion: AN_ASSERTION,
    client_id: clientId,
    state: '1',
    scope: 'a'
  };

  params = params || {};
  Object.keys(params).forEach(function(key) {
    defaults[key] = params[key];
  });
  return defaults;
}

function newToken(payload) {
  payload = payload || {};
  var ttl = payload.ttl || MAX_TTL_S;
  delete payload.ttl;
  mockAssertion().reply(200, VERIFY_GOOD);
  return Server.api.post({
    url: '/authorization',
    payload: authParams(payload)
  }).then(function(res) {
    assert.equal(res.statusCode, 200);
    assertSecurityHeaders(res);
    return Server.api.post({
      url: '/token',
      payload: {
        client_id: clientId,
        client_secret: secret,
        code: url.parse(res.result.redirect, true).query.code,
        ttl: ttl
      }
    });
  });
}

function assertInvalidRequestParam(result, param) {
  assert.equal(result.code, 400);
  assert.equal(result.message, 'Invalid request parameter');
  assert.equal(result.validation.keys.length, 1);
  assert.equal(result.validation.keys[0], param);
}

// helper function to create a new user, email and token for some client
/**
 *
 * @param {String} cId - hex client id
 * @param {Object} [options] - custom options
 * @param {Object} [options.uid] - custom uid
 * @param {Object} [options.email] - custom email
 * @param {Object} [options.scopes] - custom scopes
 */
function getUniqueUserAndToken(cId, options) {
  options = options || {};
  if (! cId) {
    throw new Error('No client id set');
  }

  var uid = options.uid || unique(16).toString('hex');
  var email = options.email || unique(4).toString('hex') + '@mozilla.com';

  return db.generateAccessToken({
    clientId: buf(cId),
    userId: buf(uid),
    email: email,
    scope: options.scopes || [auth.SCOPE_CLIENT_MANAGEMENT]
  }).then(function (token) {
    return {
      uid: uid,
      email: email,
      token: token.token.toString('hex')
    };
  });
}

function clientByName(name) {
  return config.get('clients').reduce(function (client, lastClient) {
    return client.name === name ? client : lastClient;
  });
}


describe('/v1', function() {
  before(function(done) {

    P.all([
      genAssertion(USERID + config.get('browserid.issuer')).then(function(ass) {
        AN_ASSERTION = ass;
      }),
      db.ping().then(function() {
        client = clientByName('Mocha');
        clientId = client.id;
        assert.equal(encrypt.hash(secret).toString('hex'), client.hashedSecret);
        assert.equal(encrypt.hash(secretPrevious).toString('hex'), client.hashedSecretPrevious);
        badSecret = Buffer(secret, 'hex').slice();
        badSecret[badSecret.length - 1] ^= 1;
        badSecret = badSecret.toString('hex');
      })
    ]).done(function() { done(); }, done);
  });

  afterEach(function() {
    nock.cleanAll();
  });

  describe('/authorization', function() {

    describe('GET', function() {
      it('redirects with all query params', function() {
        return Server.api
        .get('/authorization?client_id=123&state=321&scope=1&action=signup&a=b')
        .then(function(res) {
          assert.equal(res.statusCode, 302);
          assertSecurityHeaders(res);
          var redirect = url.parse(res.headers.location, true);

          assert.equal(redirect.query.client_id, '123');
          assert.equal(redirect.query.state, '321');
          assert.equal(redirect.query.scope, '1');
          // unknown query params are forwarded
          assert.equal(redirect.query.a, 'b');
          var target = url.parse(config.get('contentUrl'), true);
          assert.equal(redirect.pathname, target.pathname + 'signup');
          assert.equal(redirect.host, target.host);
        });
      });

      it('redirects `action=signin` to signin', function() {
        return Server.api
        .get('/authorization?client_id=123&state=321&scope=1&action=signin&a=b')
        .then(function(res) {
          assert.equal(res.statusCode, 302);
          assertSecurityHeaders(res);
          var redirect = url.parse(res.headers.location, true);

          assert.equal(redirect.query.client_id, '123');
          assert.equal(redirect.query.state, '321');
          assert.equal(redirect.query.scope, '1');
          // unknown query params are forwarded
          assert.equal(redirect.query.a, 'b');
          var target = url.parse(config.get('contentUrl'), true);
          assert.equal(redirect.pathname, target.pathname + 'signin');
          assert.equal(redirect.host, target.host);
        });
      });

      it('redirects no action to contentUrl root', function() {
        return Server.api.get('/authorization?client_id=123&state=321&scope=1')
        .then(function(res) {
          assert.equal(res.statusCode, 302);
          assertSecurityHeaders(res);
          var redirect = url.parse(res.headers.location, true);

          var target = url.parse(config.get('contentUrl'), true);
          assert.equal(redirect.pathname, target.pathname);
          assert.equal(redirect.host, target.host);
        });
      });

      it('redirects `action=force_auth` to force_auth', function() {
        var endpoint = '/authorization?action=force_auth&email=' +
          encodeURIComponent(VEMAIL);
        return Server.api.get(endpoint)
        .then(function(res) {
          assert.equal(res.statusCode, 302);
          assertSecurityHeaders(res);
          var redirect = url.parse(res.headers.location, true);

          var target = url.parse(config.get('contentUrl'), true);
          assert.equal(redirect.pathname, target.pathname + 'force_auth');
          assert.equal(redirect.host, target.host);
          assert.equal(redirect.query.email, VEMAIL);
        });
      });

      it('rewrites `login_hint=foo` to `email=foo`', function() {
        var endpoint = '/authorization?action=signin&login_hint=' +
          encodeURIComponent(VEMAIL);
        return Server.api.get(endpoint)
        .then(function(res) {
          assert.equal(res.statusCode, 302);
          assertSecurityHeaders(res);
          var redirect = url.parse(res.headers.location, true);

          var target = url.parse(config.get('contentUrl'), true);
          assert.equal(redirect.pathname, target.pathname + 'signin');
          assert.equal(redirect.host, target.host);
          assert.equal(redirect.query.email, VEMAIL);
        });
      });

      it('should fail for invalid action', function() {
        return Server.api
        .get('/authorization?client_id=123&state=321&scope=1&action=something_invalid&a=b')
        .then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
          assert.equal(res.result.errno, 109);
          assert.equal(res.result.validation, 'action');
        });
      });
    });

    describe('content-type', function() {
      it('should fail if unsupported', function() {
        return Server.api.post({
          url: '/authorization',
          headers: {
            'content-type': 'text/plain'
          },
          payload: authParams()
        }).then(function(res) {
          assert.equal(res.statusCode, 415);
          assertSecurityHeaders(res);
          assert.equal(res.result.errno, 113);
        });
      });
    });

    describe('untrusted client scope', function() {
      it('should fail if invalid scopes', function() {
        var client = clientByName('Untrusted');
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            client_id: client.id,
            scope: 'profile profile:write profile:uid'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
          assert.equal(res.result.errno, 114);
          assert.ok(res.result.invalidScopes.indexOf('profile') !== -1);
          assert.ok(res.result.invalidScopes.indexOf('profile:write') !== -1);
          assert.ok(res.result.invalidScopes.indexOf('profile:uid') === -1);
        });
      });

      it('should succeed if valid scope', function() {
        var client = clientByName('Untrusted');
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            client_id: client.id,
            scope: 'profile:email profile:uid'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
        });
      });
    });

    describe('?client_id', function() {

      it('is required', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            client_id: undefined
          })
        }).then(function(res) {
          assertInvalidRequestParam(res.result, 'client_id');
          assertSecurityHeaders(res);
        });
      });

    });

    describe('?assertion', function() {

      it('is required', function() {
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            assertion: undefined
          })
        }).then(function(res) {
          assertInvalidRequestParam(res.result, 'assertion');
          assertSecurityHeaders(res);
        });
      });

      it('errors correctly if invalid', function() {
        mockAssertion().reply(400, '{"status":"failure"}');
        return Server.api.post({
          url: '/authorization',
          payload: authParams()
        }).then(function(res) {
          assert.equal(res.result.code, 401);
          assert.equal(res.result.message, 'Invalid assertion');
          assertSecurityHeaders(res);
        });
      });

    });

    describe('?redirect_uri', function() {
      it('is optional', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            redirect_uri: client.redirectUri
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert(res.result.redirect);
        });
      });

      it('must be same as registered redirect', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            redirect_uri: 'http://localhost:8080/derp'
          })
        }).then(function(res) {
          assert.equal(res.result.code, 400);
          assert.equal(res.result.message, 'Incorrect redirect_uri');
          assertSecurityHeaders(res);
        });
      });

      describe('with config.localRedirects', function() {
        beforeEach(function() {
          config.set('localRedirects', true);
        });

        afterEach(function() {
          config.set('localRedirects', false);
        });

        it('must be same as registered redirect with config set', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              redirect_uri: 'http://bad.uri/derp'
            })
          }).then(function(res) {
            assert.equal(res.result.code, 400);
            assert.equal(res.result.message, 'Incorrect redirect_uri');
            assertSecurityHeaders(res);
          });
        });

        it('can be localhost with config set', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              redirect_uri: 'http://localhost:8080/derp'
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert(res.result.redirect);
          });
        });

        it('validates http and https scheme', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              redirect_uri: 'ftp://localhost:8080/derp'
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 109);
            assert.equal(res.result.message, 'Invalid request parameter');
          });
        });

        it('can be 127.0.0.1 with config set', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              redirect_uri: 'http://127.0.0.1:8080/derp'
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert(res.result.redirect);
          });
        });

      });

      it('can be a URN', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            client_id: '98e6508e88680e1b'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          var expected = 'urn:ietf:wg:oauth:2.0:fx:webchannel';
          var actual = res.result.redirect.substr(0, expected.length);
          assert.equal(actual, expected);
        });
      });
    });

    describe('?state', function() {
      it('is required', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            state: undefined
          })
        }).then(function(res) {
          assertInvalidRequestParam(res.result, 'state');
          assertSecurityHeaders(res);
        });
      });

      it('is returned', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            state: 'aa'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert.equal(url.parse(res.result.redirect, true).query.state, 'aa');
        });
      });
    });

    describe('?scope', function() {
      it('is optional', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            scope: undefined
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert(res.result.redirect);
        });
      });

      it('is restricted to expected characters', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            scope: 'profile:\u2603'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
        });
      });
    });

    describe('?response_type', function() {
      it('is optional', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            response_type: undefined
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert(res.result.redirect);
        });
      });

      it('can be code', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            response_type: 'code'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert(res.result.redirect);
        });
      });

      it('must not be something besides code or token', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            response_type: 'foo'
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
        });
      });

      it('fails if ttl is specified with code', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            response_type: 'code',
            ttl: 42
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
        });
      });

      describe('token', function() {
        var client2 = clientByName('Admin');
        assert(client2.canGrant); //sanity check

        it('does not require state argument', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              client_id: client2.id,
              state: undefined,
              response_type: 'token'
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
          });
        });

        it('does not require scope argument', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              client_id: client2.id,
              scope: undefined,
              response_type: 'token'
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
          });
        });

        it('requires a client with proper permission', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              client_id: client.id,
              response_type: 'token'
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 110);
          });
        });

        it('returns an implicit token', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              client_id: client2.id,
              response_type: 'token'
            })
          }).then(function(res) {
            var defaultExpiresIn = config.get('expiration.accessToken') / 1000;
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert(res.result.access_token);
            assert.equal(res.result.token_type, 'bearer');
            assert(res.result.scope);
            assert(res.result.expires_in <= defaultExpiresIn);
            assert(res.result.expires_in > defaultExpiresIn - 10);
            assert(res.result.auth_at);
          });
        });

        it('honours the ttl parameter', function() {
          var ttl = 42;
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              client_id: client2.id,
              response_type: 'token',
              ttl: ttl
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert(res.result.expires_in <= ttl);
            assert(res.result.expires_in > ttl - 10);
          });
        });
      });
    });

    describe('response', function() {
      describe('with a trusted client', function() {
        it('should redirect to the redirect_uri', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams()
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            var loc = url.parse(res.result.redirect, true);
            var expected = url.parse(client.redirectUri, true);
            assert.equal(loc.protocol, expected.protocol);
            assert.equal(loc.host, expected.host);
            assert.equal(loc.pathname, expected.pathname);
            assert.equal(loc.query.foo, expected.query.foo);
            assert(loc.query.code);
          });
        });
      });
    });

  });

  describe('/token', function() {

    it('disallows GET', function() {
      return Server.api.get('/token').then(function(res) {
        assert.equal(res.statusCode, 404);
        assertSecurityHeaders(res);
      });
    });

    describe('?client_id', function() {
      it('is required', function() {
        return Server.api.post({
          url: '/token',
          payload: {
            client_secret: secret,
            code: unique.code().toString('hex')
          }
        }).then(function(res) {
          assertInvalidRequestParam(res.result, 'client_id');
          assertSecurityHeaders(res);
        });
      });
    });

    describe('?client_secret', function() {
      it('is required', function() {
        return Server.api.post({
          url: '/token',
          payload: {
            client_id: clientId,
            code: unique.code().toString('hex')
          }
        }).then(function(res) {
          assertInvalidRequestParam(res.result, 'client_secret');
          assertSecurityHeaders(res);
        });
      });

      it('must match server-stored secret', function() {
        return Server.api.post({
          url: '/token',
          payload: {
            client_id: clientId,
            client_secret: badSecret,
            code: unique.code().toString('hex')
          }
        }).then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
          assert.equal(res.result.message, 'Incorrect secret');
        });
      });

      describe('previous secret', function() {
        function getCode(clientId){
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams({
              client_id: clientId
            })
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            return url.parse(res.result.redirect, true).query.code;
          });
        }

        it('should get auth token with secret', function(){
          return getCode(clientId).then(function(code) {
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                code: code
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.ok(res.result.access_token);
          });
        });

        it('should get auth token with previous secret', function(){
          return getCode(clientId).then(function(code) {
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secretPrevious,
                code: code
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.ok(res.result.access_token);
          });
        });
      });
    });

    describe('?grant_type=authorization_code', function() {
      describe('?code', function() {
        it('is required', function() {
          return Server.api.post({
            url: '/token',
            payload: {
              client_id: clientId,
              client_secret: secret
            }
          }).then(function(res) {
            assertInvalidRequestParam(res.result, 'code');
            assertSecurityHeaders(res);
          });
        });

        it('must match an existing code', function() {
          return Server.api.post({
            url: '/token',
            payload: {
              client_id: clientId,
              client_secret: secret,
              code: unique.code().toString('hex')
            }
          }).then(function(res) {
            assert.equal(res.result.code, 400);
            assert.equal(res.result.message, 'Unknown code');
            assertSecurityHeaders(res);
          });
        });

        it('must be a code owned by this client', function() {
          var secret2 = unique.secret();
          var client2 = {
            name: 'client2',
            hashedSecret: encrypt.hash(secret2),
            redirectUri: 'https://example.domain',
            imageUri: 'https://example.foo.domain/logo.png',
            trusted: true
          };
          return db.registerClient(client2).then(function() {
            mockAssertion().reply(200, VERIFY_GOOD);
            return Server.api.post({
              url: '/authorization',
              payload: authParams({
                client_id: client2.id.toString('hex')
              })
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              return url.parse(res.result.redirect, true).query.code;
            });
          }).then(function(code) {
            return Server.api.post({
              url: '/token',
              payload: {
                // client is trying to use client2's code
                client_id: clientId,
                client_secret: secret,
                code: code
              }
            });
          }).then(function(res) {
            assert.equal(res.result.code, 400);
            assert.equal(res.result.message, 'Incorrect code');
            assertSecurityHeaders(res);
          });

        });

        it('must not have expired', function() {
          this.slow(200);
          var exp = config.get('expiration.code');
          config.set('expiration.code', 50);
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams()
          }).then(function(res) {
            return url.parse(res.result.redirect, true).query.code;
          }).delay(60).then(function(code) {
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                code: code
              }
            });
          }).then(function(res) {
            assert.equal(res.result.code, 400);
            assert.equal(res.result.message, 'Expired code');
            assertSecurityHeaders(res);
          }).finally(function() {
            config.set('expiration.code', exp);
          });
        });

        it('cannot use the same code multiple times', function() {
          mockAssertion().reply(200, VERIFY_GOOD);
          return Server.api.post({
            url: '/authorization',
            payload: authParams()
          }).then(function(res) {
            return url.parse(res.result.redirect, true).query.code;
          }).then(function(code) {
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                code: code
              }
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              return Server.api.post({
                url: '/token',
                payload: {
                  client_id: clientId,
                  client_secret: secret,
                  code: code
                }
              });
            });
          }).then(function(res) {
            assert.equal(res.result.code, 400);
            assert.equal(res.result.message, 'Unknown code');
            assertSecurityHeaders(res);
          });
        });
      });

      describe('response', function() {
        describe('access_type=online', function() {
          it('should return a correct response', function() {
            mockAssertion().reply(200, VERIFY_GOOD);
            return Server.api.post({
              url: '/authorization',
              payload: authParams({
                scope: 'foo bar bar'
              })
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              return Server.api.post({
                url: '/token',
                payload: {
                  client_id: clientId,
                  client_secret: secret,
                  code: url.parse(res.result.redirect, true).query.code,
                  foo: 'bar' // testing stripUnknown
                }
              });
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              assert.equal(res.result.token_type, 'bearer');
              assert(res.result.access_token);
              assert(!res.result.refresh_token);
              assert.equal(res.result.access_token.length,
                config.get('unique.token') * 2);
              assert.equal(res.result.scope, 'foo bar');
              assert.equal(res.result.auth_at, 123456);
            });
          });
        });

        describe('access_type=offline', function() {
          it('should return a correct response', function() {
            mockAssertion().reply(200, VERIFY_GOOD);
            return Server.api.post({
              url: '/authorization',
              payload: authParams({
                scope: 'foo bar bar',
                access_type: 'offline'
              })
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              return Server.api.post({
                url: '/token',
                payload: {
                  client_id: clientId,
                  client_secret: secret,
                  code: url.parse(res.result.redirect, true).query.code
                }
              });
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              assert.equal(res.result.token_type, 'bearer');
              assert(res.result.access_token);
              assert(res.result.refresh_token);
              assert.equal(res.result.access_token.length,
                config.get('unique.token') * 2);
              assert.equal(res.result.refresh_token.length,
                config.get('unique.token') * 2);
              assert.equal(res.result.scope, 'foo bar');
              assert.equal(res.result.auth_at, 123456);
            });
          });
        });
      });

      it('with a blank scope', function() {
        mockAssertion().reply(200, VERIFY_GOOD);
        return Server.api.post({
          url: '/authorization',
          payload: authParams({
            scope: undefined
          })
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          return Server.api.post({
            url: '/token',
            payload: {
              client_id: clientId,
              client_secret: secret,
              code: url.parse(res.result.redirect, true).query.code
            }
          });
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert.equal(res.result.token_type, 'bearer');
          assert(res.result.access_token);
          assert.equal(res.result.access_token.length,
            config.get('unique.token') * 2);
          assert.equal(res.result.scope, '');
        });
      });

    });

    describe('grant_type=refresh_token', function() {

      describe('?refresh_token', function() {

        it('should be required', function() {
          return Server.api.post({
            url: '/token',
            payload: {
              client_id: clientId,
              client_secret: secret,
              grant_type: 'refresh_token'
            }
          }).then(function(res) {
            assertInvalidRequestParam(res.result, 'refresh_token');
            assertSecurityHeaders(res);
          });
        });

        it('should be an existing token', function() {
          return Server.api.post({
            url: '/token',
            payload: {
              client_id: clientId,
              client_secret: secret,
              grant_type: 'refresh_token',
              refresh_token: unique.token().toString('hex')
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 108);
          });
        });

        it('should be owned by the client_id', function() {
          var id2;
          var secret2 = unique.secret();
          var client2 = {
            name: 'client2',
            hashedSecret: encrypt.hash(secret2),
            redirectUri: 'https://example.domain',
            imageUri: 'https://example.foo.domain/logo.png',
            trusted: true
          };
          return db.registerClient(client2).then(function(c) {
            id2 = c.id.toString('hex');
            return newToken({ access_type: 'offline' }); //for main client
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            var refresh = res.result.refresh_token;
            assert(refresh);
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: id2, // client2 stole it somehow
                client_secret: secret2.toString('hex'),
                grant_type: 'refresh_token',
                refresh_token: refresh
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 108, 'invalid token');
          });
        });

        it('should not create a new refresh token', function() {
          return newToken({ access_type: 'offline' }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                grant_type: 'refresh_token',
                refresh_token: res.result.refresh_token
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.refresh_token, undefined);
          });
        });

      });

      describe('?scope', function() {

        it('should be able to reduce scopes', function() {
          return newToken({
            access_type: 'offline',
            scope: 'foo bar:baz'
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.scope, 'foo bar:baz');
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                grant_type: 'refresh_token',
                refresh_token: res.result.refresh_token,
                scope: 'foo'
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.scope, 'foo');
          });
        });

        it('should not expand scopes', function() {
          return newToken({
            access_type: 'offline',
            scope: 'foo bar:baz'
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.scope, 'foo bar:baz');
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                grant_type: 'refresh_token',
                refresh_token: res.result.refresh_token,
                scope: 'foo quux'
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 114);
          });
        });

        it('should not expand read scope to write scope', function() {
          return newToken({
            access_type: 'offline',
            scope: 'foo'
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.scope, 'foo');
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                grant_type: 'refresh_token',
                refresh_token: res.result.refresh_token,
                scope: 'foo:write'
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 114);
          });
        });

      });

      describe('?ttl', function() {

        it('should reduce the expires_in of the access_token', function() {
          return newToken({ access_type: 'offline' }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                grant_type: 'refresh_token',
                refresh_token: res.result.refresh_token,
                ttl: 60
              }
            });
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert(res.result.expires_in <= 60);
          });
        });

        it('should not exceed the maximum', function() {
          return newToken({ access_type: 'offline' }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            return Server.api.post({
              url: '/token',
              payload: {
                client_id: clientId,
                client_secret: secret,
                grant_type: 'refresh_token',
                refresh_token: res.result.refresh_token,
                ttl: MAX_TTL_S * 100
              }
            });
          }).then(function(res) {
            assertInvalidRequestParam(res.result, 'ttl');
            assertSecurityHeaders(res);
          });
        });

      });

    });

    describe('?grant_type=jwt', function() {
      const JWT_URN = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
      const JKU = config.get('serviceClients')[0].jku;
      assert.equal(config.get('serviceClients')[0].scope, 'profile',
        'test service client scope sanity check');

      function sign(payload) {
        return JWTool.sign({
          header: {
            alg: 'RS256',
            typ: 'JWT',
            jku: JKU,
            kid: 'dev-1'
          },
          payload: {
            sub: payload.sub || USERID,
            iat: Math.floor(payload.iat || (Date.now() / 1000)),
            exp: Math.floor(payload.exp || (Date.now() / 1000 + 60)),
            aud: payload.aud || (config.get('publicUrl') + '/v1/token'),
            scope: payload.scope || 'profile'
          }
        }, JWT_PRIV_KEY.pem);
      }

      function mockJwt() {
        var parts = url.parse(JKU);
        nock(parts.protocol + '//' + parts.host).get(parts.path)
          .reply(200, {
            keys: [
              JWT_PUB_KEY
            ]
          });
      }

      function request(payload) {
        var assertion = sign(payload);
        mockJwt();

        return Server.api.post({
          url: '/token',
          payload: {
            grant_type: JWT_URN,
            assertion: assertion
          }
        });
      }

      describe('response', function() {
        it('should work', function() {
          return request({
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
          });
        });
      });

      describe('userid', function() {
        it('should fail if invalid', function() {
          return request({
            sub: 'definitely not an fxa uid',
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 104);
          });
        });
      });

      describe('audience', function() {
        it('should fail if mismatch', function() {
          return request({
            aud: 'https://not.the.right.aud/ience',
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 104);
          });
        });
      });

      describe('issuedat', function() {
        it('should fail if in the future', function() {
          return request({
            iat: 60 + Math.floor(Date.now() / 1000)
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 104);
          });
        });
      });

      describe('expiresat', function() {
        it('should fail if in the past', function() {
          return request({
            exp: Math.floor(Date.now() / 1000) - 100
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 104);
          });
        });
      });

      describe('scope', function() {
        it('should be able to reduce scopes', function() {
          return request({
            scope: 'profile:email'
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.scope, 'profile:email');
          });
        });

        it('should not be able to increase scopes', function() {
          return request({
            scope: 'nuclear:codes'
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
            assert.equal(res.result.errno, 114);
          });
        });
      });
    });

    describe('?scope=openid', function() {

      function decodeJWT(b64) {
        var jwt = b64.split('.');
        return {
          header: JSON.parse(Buffer(jwt[0], 'base64').toString('utf-8')),
          claims: JSON.parse(Buffer(jwt[1], 'base64').toString('utf-8'))
        };
      }

      it('should return an id_token', function() {
        return newToken({ scope: 'openid' }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert(res.result.access_token);
          assert(res.result.id_token);
          var jwt = decodeJWT(res.result.id_token);
          var header = jwt.header;
          var claims = jwt.claims;

          assert.equal(header.alg, 'RS256');
          assert.equal(header.kid, config.get('openid.key').kid);

          assert.equal(claims.sub, USERID);
          assert.equal(claims.aud, clientId);
          assert.equal(claims.iss, config.get('openid.issuer'));
          var now = Math.floor(Date.now() / 1000);
          assert(claims.iat <= now);
          assert(claims.exp > now);
        });
      });

    });

  });

  describe('/client', function() {
    var clientName = 'test/api/client';
    var clientUri = 'http://test.api/client';

    var tok;
    var badTok;

    before(function() {
      return db.generateAccessToken({
        clientId: buf(clientId),
        userId: buf(USERID),
        email: VEMAIL,
        scope: [auth.SCOPE_CLIENT_MANAGEMENT]
      }).then(function(token) {
        tok = token.token.toString('hex');
        return db.generateAccessToken({
          clientId: buf(clientId),
          userId: unique(16),
          email: 'user@not.allow.ed',
          scope: [auth.SCOPE_CLIENT_MANAGEMENT]
        });
      }).then(function(token) {
        badTok = token.token.toString('hex');
      });
    });

    describe('GET /:id', function() {
      describe('response', function() {
        it('should return the correct response', function() {
          return Server.api.get('/client/' + clientId)
          .then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            var body = res.result;
            assert.equal(body.name, client.name);
            assert(body.image_uri);
            assert(body.redirect_uri);
            assert(body.trusted);
          });
        });
      });

      it('should allow for clients with no redirect_uri', function() {
        return Server.api.get('/client/ea3ca969f8c6bb0d')
          .then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            var body = res.result;
            assert(body.name);
            assert.equal(body.image_uri, '');
            assert.equal(body.redirect_uri, '');
          });
      });
    });

    describe('client management api', function() {
      it('should not be available on main server', function(){
        return P.all([
          Server.api.get('/clients'),
          Server.api.post('/client'),
          Server.api.post('/client/' + clientId),
          Server.api.delete('/client/' + clientId)
        ]).map(function(res) {
          assert.equal(res.statusCode, 404);
          assertSecurityHeaders(res);
        });
      });

      describe('GET /client/:id', function() {
        describe('response', function() {
          it('should support the client id path', function() {
            return Server.internal.api.get('/client/' + clientId)
              .then(function(res) {
                assert.equal(res.statusCode, 200);
                assertSecurityHeaders(res);
                var body = res.result;
                assert.equal(body.name, client.name);
                assert(body.image_uri);
                assert(body.redirect_uri);
              });
          });
        });
      });

      describe('GET /clients', function() {
        it('should require authorization', function() {
          return Server.internal.api.get({
            url: '/clients'
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
          });
        });

        it('should check whether the user is allowed', function() {
          return Server.internal.api.get({
            url: '/clients',
            headers: {
              authorization: 'Bearer ' + badTok
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 403);
            assertSecurityHeaders(res);
          });
        });

        it('should return an empty list of clients', function() {
          // this developer has no clients associated, it returns 0
          // value is the same as the API endpoint and a DB call

          return Server.internal.api.get({
            url: '/clients',
            headers: {
              authorization: 'Bearer ' + tok
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);

            return db.getClients(VEMAIL).then(function(clients) {
              assert.equal(res.result.clients.length, clients.length);
              assert.equal(res.result.clients.length, 0);
            });
          });
        });

        it('should return a list of clients for a developer', function() {
          var vemail, tok;

          return getUniqueUserAndToken(clientId)
            .then(function(data) {
              tok = data.token;
              vemail = data.email;
              // make this user a developer
              return db.activateDeveloper(vemail);
            }).then(function() {
              return db.getDeveloper(vemail);
            }).then(function(developer) {
              var devId = developer.developerId;
              return db.registerClientDeveloper(devId, clientId);
            }).then(function () {
              return Server.internal.api.get({
                url: '/clients',
                headers: {
                  authorization: 'Bearer ' + tok
                }
              });
            }).then(function(res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              return db.getClients(vemail).then(function(clients) {
                assert.equal(res.result.clients.length, clients.length);
                assert.equal(res.result.clients.length, 1);
              });
            });
        });
      });

      describe('POST', function() {
        before(function() {
          return Server.internal.api.post({
            url: '/developer/activate',
            headers: {
              authorization: 'Bearer ' + tok
            }
          }).then(function(res) {
          });
        });

        it('should register a client', function() {
          return Server.internal.api.post({
            url: '/client',
            headers: {
              authorization: 'Bearer ' + tok,
            },
            payload: {
              name: clientName,
              redirect_uri: clientUri,
              image_uri: clientUri + '/image',
              can_grant: true,
              trusted: true
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 201);
            assertSecurityHeaders(res);
            var client = res.result;
            assert(client.id);
            return db.getClient(client.id).then(function(klient) {
              assert.equal(klient.id.toString('hex'), client.id);
              assert.equal(klient.name, client.name);
              assert.equal(klient.redirectUri, client.redirect_uri);
              assert.equal(klient.imageUri, client.image_uri);
              assert.equal(klient.redirectUri, clientUri);
              assert.equal(klient.imageUri, clientUri + '/image');
              assert.equal(klient.canGrant, true);
              assert.equal(klient.trusted, true);
            });
          });
        });

        it('should require authorization', function() {
          return Server.internal.api.post({
            url: '/client',
            payload: {
              name: 'dont matter'
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
          });
        });

        it('should check the whether the user is allowed', function() {
          return Server.internal.api.post({
            url: '/client',
            headers: {
              authorization: 'Bearer ' + badTok
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 403);
            assertSecurityHeaders(res);
          });
        });

        it('should default optional fields to sensible values', function() {
          return Server.internal.api.post({
            url: '/client',
            headers: {
              authorization: 'Bearer ' + tok,
            },
            payload: {
              name: clientName,
              redirect_uri: clientUri
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 201);
            assertSecurityHeaders(res);
            var client = res.result;
            assert(client.id);
            assert(client.image_uri === '');
            assert(client.can_grant === false);
            assert(client.trusted === false);
            return db.getClient(client.id).then(function(klient) {
              assert.equal(klient.id.toString('hex'), client.id);
              assert.equal(klient.name, client.name);
              assert.equal(klient.imageUri, '');
              assert.equal(klient.canGrant, false);
              assert.equal(klient.trusted, false);
            });
          });
        });
      });

      describe('POST /:id', function() {
        var id = unique.id();

        it('should forbid update to unknown developers', function() {
          var vemail, tok;
          var id = unique.id();
          var client = {
            name: 'test/api/update',
            id: id,
            hashedSecret: encrypt.hash(unique.secret()),
            redirectUri: 'https://example.domain',
            imageUri: 'https://example.com/logo.png',
            trusted: true
          };

          return db.registerClient(client)
            .then(function () {
              return getUniqueUserAndToken(id.toString('hex'));
            })
            .then(function(data) {
              tok = data.token;
              vemail = data.email;

              return db.activateDeveloper(vemail);
            }).then(function () {
              return db.getDeveloper(vemail);
            }).then(function (developer) {
            }).then(function () {
              return Server.internal.api.post({
                url: '/client/' + id.toString('hex'),
                headers: {
                  authorization: 'Bearer ' + tok,
                },
                payload: {
                  name: 'updated',
                  redirect_uri: clientUri
                }
              });
            }).then(function (res) {
              assert.equal(res.statusCode, 401);
              assertSecurityHeaders(res);
            });
        });

        it('should allow client update', function() {
          var vemail, tok, devId;
          var id = unique.id();
          var client = {
            name: 'test/api/update2',
            id: id,
            hashedSecret: encrypt.hash(unique.secret()),
            redirectUri: 'https://example.domain',
            imageUri: 'https://example.com/logo.png',
            trusted: true
          };

          return db.registerClient(client)
            .then(function () {
              return getUniqueUserAndToken(id.toString('hex'));
            })
            .then(function(data) {
              tok = data.token;
              vemail = data.email;

              return db.activateDeveloper(vemail);
            }).then(function () {
              return db.getDeveloper(vemail);
            }).then(function (developer) {
              devId = developer.developerId;
            }).then(function () {
              return db.registerClientDeveloper(
                devId.toString('hex'),
                id.toString('hex')
              );
            }).then(function () {
              return Server.internal.api.post({
                url: '/client/' + id.toString('hex'),
                headers: {
                  authorization: 'Bearer ' + tok,
                },
                payload: {
                  name: 'updated',
                  redirect_uri: clientUri
                }
              });
            }).then(function (res) {
              assert.equal(res.statusCode, 200);
              assertSecurityHeaders(res);
              assert.equal(res.payload, '{}');
              return db.getClient(client.id);
            }).then(function (klient) {
              assert.equal(klient.name, 'updated');
              assert.equal(klient.redirectUri, clientUri);
              assert.equal(klient.imageUri, client.imageUri);
              assert.equal(klient.trusted, true);
              assert.equal(klient.canGrant, false);
            });
        });

        it('should forbid unknown properties', function () {
          return Server.internal.api.post({
            url: '/client/' + id.toString('hex'),
            headers: {
              authorization: 'Bearer ' + tok
            },
            payload: {
              foo: 'bar'
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 400);
            assertSecurityHeaders(res);
          });
        });

        it('should require authorization', function() {
          return Server.internal.api.post({
            url: '/client/' + id.toString('hex'),
            payload: {
              name: 'dont matter'
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
          });
        });

        it('should check the whether the user is allowed', function() {
          return Server.internal.api.post({
            url: '/client/' + id.toString('hex'),
            headers: {
              authorization: 'Bearer ' + badTok
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 403);
            assertSecurityHeaders(res);
          });
        });
      });

      describe('DELETE /:id', function() {

        it('should delete the client', function() {
          var vemail, tok, devId;
          var id = unique.id();
          var client = {
            name: 'test/api/deleteOwner',
            id: id,
            hashedSecret: encrypt.hash(unique.secret()),
            redirectUri: 'https://example.domain',
            imageUri: 'https://example.com/logo.png',
            trusted: true
          };

          return db.registerClient(client)
            .then(function () {
              return getUniqueUserAndToken(id.toString('hex'));
            })
            .then(function(data) {
              tok = data.token;
              vemail = data.email;

              return db.activateDeveloper(vemail);
            }).then(function () {
              return db.getDeveloper(vemail);
            }).then(function (developer) {
              devId = developer.developerId;
            }).then(function () {
              return db.registerClientDeveloper(
                devId.toString('hex'),
                id.toString('hex')
              );
            }).then(function () {
              return Server.internal.api.delete({
                url: '/client/' + id.toString('hex'),
                headers: {
                  authorization: 'Bearer ' + tok,
                }
              });
            }).then(function(res) {
              assert.equal(res.statusCode, 204);
              assertSecurityHeaders(res);
              return db.getClient(id);
            }).then(function(client) {
              assert.equal(client, undefined);
            });
        });

        it('should not delete the client if not owner', function() {
          var vemail, tok;
          var id = unique.id();
          var client = {
            name: 'test/api/deleteOwner',
            id: id,
            hashedSecret: encrypt.hash(unique.secret()),
            redirectUri: 'https://example.domain',
            imageUri: 'https://example.com/logo.png',
            trusted: true
          };

          return db.registerClient(client)
            .then(function () {
              return getUniqueUserAndToken(id.toString('hex'));
            })
            .then(function(data) {
              tok = data.token;
              vemail = data.email;

              return db.activateDeveloper(vemail);
            }).then(function () {
              return db.getDeveloper(vemail);
            }).then(function (developer) {
            }).then(function () {
              return Server.internal.api.delete({
                url: '/client/' + id.toString('hex'),
                headers: {
                  authorization: 'Bearer ' + tok,
                }
              });
            }).then(function(res) {
              assert.equal(res.statusCode, 401);
              assertSecurityHeaders(res);
              return db.getClient(id);
            }).then(function(klient) {
              assert.equal(klient.id.toString('hex'), id.toString('hex'));
            });
        });

        it('should require authorization', function() {
          var id = unique.id();

          return Server.internal.api.delete({
            url: '/client/' + id.toString('hex'),
            payload: {
              name: 'dont matter'
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 401);
            assertSecurityHeaders(res);
          });
        });

        it('should check the whether the user is allowed', function() {
          var id = unique.id();

          return Server.internal.api.delete({
            url: '/client/' + id.toString('hex'),
            headers: {
              authorization: 'Bearer ' + badTok
            }
          }).then(function(res) {
            assert.equal(res.statusCode, 403);
            assertSecurityHeaders(res);
          });
        });
      });
    });

  });

  describe('/developer', function() {
    describe('POST /developer/activate', function() {
      it('should create a developer', function() {
        var vemail, tok;

        return getUniqueUserAndToken(clientId)
          .then(function(data) {
            tok = data.token;
            vemail = data.email;

            return db.getDeveloper(vemail);
          }).then(function(developer) {
            assert.equal(developer, null);

            return Server.internal.api.post({
              url: '/developer/activate',
              headers: {
                authorization: 'Bearer ' + tok
              }
            });

          }).then(function(res) {
            assert.equal(res.statusCode, 200);
            assertSecurityHeaders(res);
            assert.equal(res.result.email, vemail);
            assert(res.result.developerId);
            assert(res.result.createdAt);

            return db.getDeveloper(vemail);
          }).then(function(developer) {

            assert.equal(developer.email, vemail);
          });
      });
    });

    describe('GET /developer', function() {
      it('should not exist', function() {
        return Server.internal.api.get('/developer')
          .then(function(res) {
            assert.equal(res.statusCode, 404);
            assertSecurityHeaders(res);
          });
      });
    });

  });

  describe('/verify', function() {

    describe('unknown token', function() {
      it('should not error', function() {
        return Server.api.post({
          url: '/verify',
          payload: {
            token: unique.token().toString('hex')
          }
        }).then(function(res) {
          assert.equal(res.statusCode, 400);
          assertSecurityHeaders(res);
        });
      });
    });

    it('should reject expired tokens from after the epoch', function() {
      this.slow(2200);
      var epoch = config.get('expiration.accessTokenExpiryEpoch');
      config.set('expiration.accessTokenExpiryEpoch', Date.now());
      return newToken({
        ttl: 1
      }).delay(1500).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        assert.equal(res.result.expires_in, 1);
        return Server.api.post({
          url: '/verify',
          payload: {
            token: res.result.access_token
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 400);
        assertSecurityHeaders(res);
        assert.equal(res.result.errno, 115);
      }).finally(function() {
        config.set('expiration.accessTokenExpiryEpoch', epoch);
      });
    });

    it('should accept expired tokens from before the epoch', function() {
      this.slow(2200);
      var epoch = config.get('expiration.accessTokenExpiryEpoch');
      config.set('expiration.accessTokenExpiryEpoch', Date.now() + 2000);
      return newToken({
        ttl: 1
      }).delay(1500).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        assert.equal(res.result.expires_in, 1);
        return Server.api.post({
          url: '/verify',
          payload: {
            token: res.result.access_token
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
      }).finally(function() {
        config.set('expiration.accessTokenExpiryEpoch', epoch);
      });
    });

    describe('response', function() {
      it('should return the correct response', function() {
        return newToken({
          scope: 'profile'
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          return Server.api.post({
            url: '/verify',
            payload: {
              token: res.result.access_token
            }
          });
        }).then(function(res) {
          assert.equal(res.statusCode, 200);
          assertSecurityHeaders(res);
          assert.equal(res.result.user, USERID);
          assert.equal(res.result.client_id, clientId);
          assert.equal(res.result.scope[0], 'profile');
          assert.equal(res.result.email, VEMAIL);
        });
      });
    });

    it('should return the email with profile:email scope', function() {
      return newToken({ scope: 'profile:email' }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        return Server.api.post({
          url: '/verify',
          payload: {
            token: res.result.access_token
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        assert.equal(res.result.email, VEMAIL);
      });
    });

    it('should not return the email if opted out', function() {
      return newToken({ scope: 'profile:email' }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        return Server.api.post({
          url: '/verify',
          payload: {
            token: res.result.access_token,
            email: false
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        assert.equal(res.result.email, undefined);
      });
    });

  });

  describe('/destroy', function() {
    it('should destroy access tokens', function() {
      var token;
      return newToken().then(function(res) {
        token = res.result.access_token;
        return Server.api.post({
          url: '/destroy',
          payload: {
            token: token
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        assert.deepEqual(res.result, {});
        return db.getAccessToken(encrypt.hash(token)).then(function(tok) {
          assert.equal(tok, undefined);
        });
      });
    });

    it('should destroy refresh tokens', function() {
      var token;
      return newToken({ access_type: 'offline' }).then(function(res) {
        token = res.result.refresh_token;
        return Server.api.post({
          url: '/destroy',
          payload: {
            refresh_token: token
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
        assert.deepEqual(res.result, {});
        return db.getRefreshToken(encrypt.hash(token)).then(function(tok) {
          assert.equal(tok, undefined);
        });
      });
    });
    it('should accept client_secret', function() {
      return newToken().then(function(res) {
        return Server.api.post({
          url: '/destroy',
          payload: {
            token: res.result.access_token,
            client_secret: 'foo'
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
      });
    });
    it('should accept empty client_secret', function() {
      return newToken().then(function(res) {
        return Server.api.post({
          url: '/destroy',
          payload: {
            token: res.result.access_token,
            client_secret: ''
          }
        });
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);
      });
    });
  });

  describe('/jwks', function() {
    it('should not include the private part of the key', function() {
      return Server.api.get({
        url: '/jwks'
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);

        var key = res.result.keys[0];
        assert(key.n);
        assert(key.e);
        assert(!key.d);
      });
    });

    it('should include the oldKey if present', function() {
      return Server.api.get({
        url: '/jwks'
      }).then(function(res) {
        assert.equal(res.statusCode, 200);
        assertSecurityHeaders(res);

        var keys = res.result.keys;
        assert.equal(keys.length, 2);
        assert(!keys[1].d);
        assert.notEqual(keys[0].kid, keys[1].kid);
      });
    });
  });

  describe('/client-tokens', function() {
    var BAD_TOKEN = '0000000000000000000000000000000000000000000000000000000000000000';
    var tokenWithClientWrite;
    var tokenWithoutClientWrite;
    var user1;
    var user2;
    var client1Id;
    var client2Id;
    var client1;
    var client2;

    beforeEach(function () {
      user1 = {
        uid: unique(16).toString('hex'),
        email: unique(10).toString('hex') + '@token.city'
      };

      user2 = {
        uid: unique(16).toString('hex'),
        email: unique(10).toString('hex') + '@token.city'
      };

      client1Id = unique.id();
      client1 = {
        name: 'test/api/client-tokens/list-b',
        id: client1Id,
        hashedSecret: encrypt.hash(unique.secret()),
        redirectUri: 'https://example.domain',
        imageUri: 'https://example.com/logo.png',
        trusted: true
      };

      client2Id = unique.id();
      client2 = {
        name: 'test/api/client-tokens/list-a',
        id: client2Id,
        hashedSecret: encrypt.hash(unique.secret()),
        redirectUri: 'https://example.domain',
        imageUri: 'https://example.com/logo.png',
        trusted: false
      };

      // create a new client
      return db.registerClient(client1)
        .then(function () {
          // user1 gets a client write token
          return getUniqueUserAndToken(client1Id.toString('hex'), {
            uid: user1.uid,
            email: user1.email,
            scopes: ['profile', 'clients:write']
          });
        })
        .then(function (result) {
          tokenWithClientWrite = result.token;
        });
    });

    describe('GET /client-tokens', function() {

      it('should list connected services in set order', function() {
        return db.registerClient(client2)
          .then(function () {
            return getUniqueUserAndToken(client2Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['profile']
            });
          })
          .then(function (result) {
            tokenWithoutClientWrite = result.token;

            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithoutClientWrite
              }
            });
          })
          .then(function (res) {
            var result = res.result;
            assert.equal(result.code, 403, 'list does not fetch without a proper token');
            assert.equal(result.error, 'Forbidden');
            assertSecurityHeaders(res);

            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            // The API sorts the results by createdAt and then by name
            // The precision is one second, this test guarantees that if
            // the tokens were created in the same second, they will still be sorted by name.
            var result = res.result;
            assert.equal(result.length, 2);
            assert.equal(result[0].id, client2Id.toString('hex'));
            assert.ok(result[0].lastAccessTime);
            assert.equal(result[0].lastAccessTimeFormatted, 'a few seconds ago');
            assert.equal(result[0].name, 'test/api/client-tokens/list-a');

            assert.equal(result[1].id, client1Id.toString('hex'));
            assert.ok(result[1].lastAccessTime);
            assert.equal(result[1].lastAccessTimeFormatted, 'a few seconds ago');
            assert.equal(result[1].name, 'test/api/client-tokens/list-b');
            assertSecurityHeaders(res);
          });
      });

      it('should not list tokens of different users', function() {
        return db.registerClient(client2)
          .then(function () {
            return getUniqueUserAndToken(client2Id.toString('hex'), {
              uid: user2.uid,
              email: user2.email,
              scopes: ['profile']
            });
          })
          .then(function (res) {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            var result = res.result;
            assert.equal(result.length, 1);
            assert.equal(result[0].id, client1Id.toString('hex'));
            assert.equal(result[0].lastAccessTimeFormatted, 'a few seconds ago');
            assert.equal(result[0].name, 'test/api/client-tokens/list-b');
            assertSecurityHeaders(res);
          });
      });

      it('should not list canGrant=1 clients', function() {
        return db.registerClient({
          name: 'test/api/client-tokens/list-can-grant',
          id: client2Id,
          hashedSecret: encrypt.hash(unique.secret()),
          redirectUri: 'https://example.domain',
          imageUri: 'https://example.com/logo.png',
          trusted: true,
          canGrant: true
        })
          .then(function () {
            return getUniqueUserAndToken(client2Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['profile']
            });
          })
          .then(function (res) {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            var result = res.result;
            assert.equal(result.length, 1);
            assert.equal(result[0].id, client1Id.toString('hex'));
            assertSecurityHeaders(res);
          });
      });

      it('should only list one client for multiple tokens', function() {
        var tok;
        return getUniqueUserAndToken(client1Id.toString('hex'), {
          uid: user1.uid,
          email: user1.email,
          scopes: ['profile', 'profile:write']
        })
          .then(function () {
            return getUniqueUserAndToken(client1Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['clients:write']
            });
          })
          .then(function () {
            return getUniqueUserAndToken(client1Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['profile']
            });
          })
          .then(function (client) {
            return db.getAccessToken(encrypt.hash(client.token));
          })
          .then(function (token) {
            tok = token;
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            var result = res.result;
            assert.equal(result.length, 1);
            assert.equal(result[0].id, client1Id.toString('hex'));
            assert.equal(result[0].lastAccessTime, tok.createdAt.getTime(), 'lastAccessTime should be equal to the latest Token createdAt time');
            assertSecurityHeaders(res);
            assert.deepEqual(result[0].scope, ['clients:write', 'profile', 'profile:write']);
          });
      });

      it('should only return union of scopes for multiple tokens', function() {
        return getUniqueUserAndToken(client1Id.toString('hex'), {
          uid: user1.uid,
          email: user1.email,
          scopes: ['profile', 'profile:write']
        })
          .then(function () {
            return getUniqueUserAndToken(client1Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['clients:write']
            });
          })
          .then(function () {
            return getUniqueUserAndToken(client1Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['basket:write', 'profile:email']
            });
          })
          .then(function () {
            return getUniqueUserAndToken(client1Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['profile:uid', 'profile', 'profile:write']
            });
          })
          .then(function () {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            var result = res.result;
            assert.deepEqual(result[0].scope, ['basket:write', 'clients:write', 'profile', 'profile:email', 'profile:uid', 'profile:write']);
          });
      });

      it('errors for invalid tokens', function() {
        return Server.api.get({
          url: '/client-tokens',
          headers: {
            authorization: 'Bearer ' + BAD_TOKEN
          }
        }).then(function (res) {
          var result = res.result;
          assert.equal(result.code, 401);
          assert.equal(result.detail, 'Bearer token invalid');
          assertSecurityHeaders(res);
        });
      });

      it('errors for bad scopes', function() {
        function reqWithScopes(scopes) {
          return getUniqueUserAndToken(client1Id.toString('hex'), {
            uid: user1.uid,
            email: user1.email,
            scopes: scopes
          }).then(function (result) {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + result.token
              }
            });
          });
        }

        return P.all([
          reqWithScopes(['clients']),
          reqWithScopes(['bar:foo:clients:write']),
          reqWithScopes(['clients:write:foo']),
          reqWithScopes(['clients:writ'])
        ]).then(function (result) {
          assert.equal(result[0].statusCode, 403);
          assert.equal(result[1].statusCode, 403);
          assert.equal(result[2].statusCode, 403);
          assert.equal(result[3].statusCode, 403);
          result.forEach(assertSecurityHeaders);
        });
      });

      it('requires auth', function() {
        return Server.api.get({
          url: '/client-tokens',
          headers: {
          }
        }).then(function (res) {
          var result = res.result;
          assert.equal(result.code, 401);
          assert.equal(result.detail, 'Bearer token not provided');
          assertSecurityHeaders(res);
        });
      });
    });

    describe('DELETE /client-tokens/{client_id}', function() {

      it('deletes all tokens for some client id', function() {
        var user2ClientWriteToken;
        return db.registerClient(client2)
          .then(function () {
            return getUniqueUserAndToken(client2Id.toString('hex'), {
              uid: user1.uid,
              email: user1.email,
              scopes: ['profile']
            });
          })
          .then(function () {
            return getUniqueUserAndToken(client2Id.toString('hex'), {
              uid: user2.uid,
              email: user2.email,
              scopes: ['profile', 'clients:write']
            });
          })
          .then(function (res) {
            user2ClientWriteToken = res.token;

            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            assert.equal(res.result.length, 2);
            assertSecurityHeaders(res);
            return Server.api.delete({
              url: '/client-tokens/' + client2Id.toString('hex'),
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function () {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            assert.equal(res.result.length, 1);
            assertSecurityHeaders(res);

            return Server.api.delete({
              url: '/client-tokens/' + client1Id.toString('hex'),
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function () {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + tokenWithClientWrite
              }
            });
          })
          .then(function (res) {
            assert.equal(res.result.code, 401, 'client:write token was deleted');
            assert.equal(res.result.detail, 'Bearer token invalid');
            assertSecurityHeaders(res);
          })
          .then(function () {
            return Server.api.get({
              url: '/client-tokens',
              headers: {
                authorization: 'Bearer ' + user2ClientWriteToken
              }
            });
          })
          .then(function (res) {
            assert.equal(res.statusCode, 200, 'user2 tokens not deleted');
            assertSecurityHeaders(res);
            assert.equal(res.result.length, 1);
          });
      });

      it('errors for invalid tokens', function() {
        return Server.api.delete({
          url: '/client-tokens/' + clientId,
          headers: {
            authorization: 'Bearer ' + BAD_TOKEN
          }
        }).then(function (res) {
          var result = res.result;
          assert.equal(result.code, 401);
          assert.equal(result.detail, 'Bearer token invalid');
          assertSecurityHeaders(res);
        });
      });

      it('requires auth', function() {
        return Server.api.delete({
          url: '/client-tokens/' + clientId,
          headers: {
          }
        }).then(function (res) {
          var result = res.result;
          assert.equal(result.code, 401);
          assert.equal(result.detail, 'Bearer token not provided');
          assertSecurityHeaders(res);
        });
      });

      it('errors for bad scopes', function() {
        function reqWithScopes(scopes) {
          return getUniqueUserAndToken(clientId, {
            scopes: scopes
          }).then(function (result) {
            return Server.api.delete({
              url: '/client-tokens/' + clientId,
              headers: {
                authorization: 'Bearer ' + result.token
              }
            });
          });
        }

        return P.all([
          reqWithScopes(['clients']),
          reqWithScopes(['bar:foo:clients:write']),
          reqWithScopes(['clients:write:foo']),
          reqWithScopes(['clients:writ'])
        ]).then(function (result) {
          assert.equal(result[0].statusCode, 403);
          assert.equal(result[1].statusCode, 403);
          assert.equal(result[2].statusCode, 403);
          assert.equal(result[3].statusCode, 403);
          result.forEach(assertSecurityHeaders);
        });
      });

    });

  });
});
