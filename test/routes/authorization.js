/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const assert = require('insist');
const Joi = require('joi');
const route = require('../../lib/routes/authorization');
const validation = route.validate.payload;

const CLIENT_ID = '98e6508e88680e1b';
// jscs:disable
const BASE64URL_STRING = 'TG9yZW0gSXBzdW0gaXMgc2ltcGx5IGR1bW15IHRleHQgb2YgdGhlIHByaW50aW5nIGFuZCB0eXBlc2V0dGluZyBpbmR1c3RyeS4gTG9yZW0gSXBzdW0gaGFzIGJlZW4gdGhlIGluZHVzdHJ5J3Mgc3RhbmRhcmQgZHVtbXkgdGV4dCBldmVyIHNpbmNlIHRoZSAxNTAwcywgd2hlbiBhbiB1bmtub3duIHByaW50ZXIgdG9vayBhIGdhbGxleSBvZiB0eXBlIGFuZCBzY3JhbWJsZWQgaXQgdG8gbWFrZSBhIHR5cGUgc3BlY2ltZW4gYm9v';
// jscs:enable
const PKCE_CODE_CHALLENGE = 'iyW5ScKr22v_QL-rcW_EGlJrDSOymJvrlXlw4j7JBiQ';
const PKCE_CODE_CHALLENGE_METHOD = 'S256';

function joiAssertFail(req, param, messagePostfix) {
  messagePostfix = messagePostfix || 'is required';
  let fail = null;

  try {
    Joi.assert(req, validation);
  } catch (err) {
    fail = true;
    assert.ok(err.isJoi);
    assert.ok(err.name, 'ValidationError');
    assert.equal(err.details[0].message, `"${param}" ${messagePostfix}`);
  }

  if (! fail) {
    throw new Error('Did not throw!');
  }
}

describe('/authorization POST', function () {
  it('fails with no client_id', () => {
    joiAssertFail({
      foo: 1
    }, 'client_id');
  });

  it('fails with no assertion', () => {
    joiAssertFail({
      client_id: CLIENT_ID
    }, 'assertion');
  });

  it('fails with no state', () => {
    joiAssertFail({
      client_id: CLIENT_ID,
      assertion: BASE64URL_STRING,
    }, 'state');
  });

  it('fails with no state', () => {
    Joi.assert({
      client_id: CLIENT_ID,
      assertion: BASE64URL_STRING,
      state: 'foo'
    }, validation);
  });

  describe('PKCE params', function () {
    it('accepts code_challenge and code_challenge_method', () => {
      Joi.assert({
        client_id: CLIENT_ID,
        assertion: BASE64URL_STRING,
        state: 'foo',
        code_challenge: PKCE_CODE_CHALLENGE,
        code_challenge_method: PKCE_CODE_CHALLENGE_METHOD,
      }, validation);
    });

    it('accepts code_challenge and code_challenge_method', () => {
      joiAssertFail({
        client_id: CLIENT_ID,
        assertion: BASE64URL_STRING,
        state: 'foo',
        code_challenge: PKCE_CODE_CHALLENGE,
        code_challenge_method: 'bad_method',
      }, 'code_challenge_method', 'must be one of [S256]');
    });

    it('validates code_challenge', () => {
      joiAssertFail({
        client_id: CLIENT_ID,
        assertion: BASE64URL_STRING,
        state: 'foo',
        code_challenge: 'foo',
        code_challenge_method: PKCE_CODE_CHALLENGE_METHOD,
      }, 'code_challenge', 'length must be 43 characters long');
    });

    it('works with response_type code (non-default)', () => {
      Joi.assert({
        client_id: CLIENT_ID,
        assertion: BASE64URL_STRING,
        state: 'foo',
        code_challenge: PKCE_CODE_CHALLENGE,
        code_challenge_method: PKCE_CODE_CHALLENGE_METHOD,
        response_type: 'code'
      }, validation);
    });

    it('fails with response_type token', () => {
      joiAssertFail({
        client_id: CLIENT_ID,
        assertion: BASE64URL_STRING,
        state: 'foo',
        code_challenge: PKCE_CODE_CHALLENGE,
        code_challenge_method: PKCE_CODE_CHALLENGE_METHOD,
        response_type: 'token'
      }, 'code_challenge_method', 'is not allowed');
    });

  });

});
