/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*global describe,it*/

const assert = require('insist');
const authBearer = require('../lib/auth_bearer');
const proxyquire = require('proxyquire').noPreserveCache();
const AppError = require('../lib/error');
const P = require('../lib/promise');

var mockRequest = {
  headers: {
    authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000'
  }
};

var goodMocks = {
  './token': {
    verify: function () {
      return P.resolve({
        scope: ['bar:foo', 'clients:write'],
        user: 'bar'
      });
    }
  }
};

describe('authBearer', function() {

  it('exports auth configuration', function() {
    assert.equal(authBearer.AUTH_SCHEME, 'authBearer');
    assert.equal(authBearer.AUTH_STRATEGY, 'authBearer');
    assert.equal(authBearer.SCOPE_CLIENT_WRITE, 'clients:write');
    assert.ok(authBearer.strategy);
  });

  describe('authenticate', function() {
    it('provides credentials if token is valid', function(done) {
      var authBearer = proxyquire('../lib/auth_bearer', goodMocks);

      authBearer.strategy().authenticate(mockRequest, function (err, result) {
        assert.equal(result.credentials.user, 'bar');
        done();
      });
    });

    it('errors if no Bearer in request', function(done) {
      var authBearer = proxyquire('../lib/auth_bearer', goodMocks);
      authBearer.strategy().authenticate({
        headers: {}
      }, function (err, result) {
        assert.equal(result, null);
        assert.equal(err.output.payload.detail, 'Bearer token not provided');
        done();
      });
    });

    it('errors if invalid token', function(done) {
      var mocks = {
        './token': {
          verify: function () {
            return P.reject(AppError.invalidToken());
          }
        }
      };
      var authBearer = proxyquire('../lib/auth_bearer', mocks);
      authBearer.strategy().authenticate(mockRequest, function (err, result) {
        assert.equal(err.output.payload.detail, 'Bearer token invalid');
        assert.equal(result, null);
        done();
      });
    });

  });
});
