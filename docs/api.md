# Firefox Accounts OAuth Server API

## Overview

### URL Structure

```
https://<server-url>/v1/<api-endpoint>
```

Note that:

- All API access must be over HTTPS
- The URL embeds a version identifier "v1"; future revisions of this API may introduce new version numbers.
- The base URL of the server may be configured on a per-client basis

### Gryphon

Firefox Accounts uses a modified OAuth flow. Whereas typically, you
would use `bearer` tokens to access a user's data, we use request
signing using a secret-key that only you know. This secret-key should be
unique per user, and you authorize it with use by passing a [code][] and
the corresponding public-key. This ends up being more secure in multiple
ways.

To facilitate this, we use the
[Gryphon](https://github.com/seanmonstar/gryphon) authorization scheme.
The provided reference library includes an easy way to generate key
pairs. We use Ed25519 keys, which are higher strength than RSA or DSA,
smaller, and faster to generate, sign, and verify with.

### Errors

Invalid requests will return 4XX responses. Internal failures will return 5XX. Both will include JSON responses describing the error.

Example error:

```js
{
  "code": 400, // matches the HTTP status code
  "errno": 101, // stable application-level error number
  "error": "Bad Request", // string description of error type
  "message": "Unknown client"
}
```

The currently-defined error responses are:

- status code, errno: description
- 400, 101: unknown client id
- 400, 102: incorrect client secret
- 400, 103: redirect_uri doesn't match registered value
- 400, 104: invalid fxa assertion 
- 400, 105: unknown code
- 400, 106: incorrect code
- 400, 107: expired code
- 400, 108: existing pubkey
- 400, 109: invalid request parameter
- 500, 999: internal server error

## API Endpoints


- [GET /v1/authorization][redirect]
- [POST /v1/authorization][authorization]
- [POST /v1/pubkey][pubkey]
- [GET /v1/client/:id][client]
- [POST /v1/verify][verify]

### GET /v1/client/:id

This endpoint is for the fxa-content-server to retreive information
about a client to show in its user interface.

#### Request Parameters

- `id`: The `client_id` of a client asking for permission.

Example:

```
curl -v "https://oauth.accounts.firefox.com/v1/client/5901bd09376fadaa"
```

#### Response

A valid 200 response will be a JSON blob with the following properties:

- `name`: A string name of the client.
- `image_uri`: A url to a logo or image that represents the client.
- `redirect_uri`: The url registered to redirect to after successful oauth.

Example:

```js
{
  "name": "Where's My Fox",
  "image_uri": "https://mozilla.org/firefox.png",
  "redirect_uri": "https://wheres.my.firefox.com/oauth"
}
```

### GET /v1/authorization

This endpoint starts the OAuth flow. A client redirects the user agent
to this url. This endpoint will then redirect to the appropriate
content-server page.

#### Request Parameters

- `client_id`: The id returned from client registration.
- `state`: A value that will be returned to the client as-is upon redirection, so that clients can verify the redirect is authentic.
- `redirect_uri`: Optional. If supplied, a string URL of where to redirect afterwards. Must match URL from registration.
- `scope`: Optional. A string-separated list of scopes that the user has authorized. This could be pruned by the user at the confirmation dialog.
- `action`: Optional. If provided, should be either `signup` or `signin`. Send to improve user experience, based on whether they clicked on a Sign In or Sign Up button.

Example:

```
curl -v "https://oauth.accounts.firefox.com/v1/authorization?client_id=5901bd09376fadaa&state=1234&scope=profile:email&action=signup"
```

### POST /v1/authorization

This endpoint should be used by the fxa-content-server, requesting that
we supply a short-lived code (currently 15 minutes) that will be sent
back to the client. This code will be sent with a public-key at the
[pubkey][] endpoint.

#### Request Parameters

- `client_id`: The id returned from client registration.
- `assertion`: A FxA assertion for the signed-in user.
- `state`: A value that will be returned to the client as-is upon redirection, so that clients can verify the redirect is authentic.
- `redirect_uri`: Optional. If supplied, a string URL of where to redirect afterwards. Must match URL from registration.
- `scope`: Optional. A string-separated list of scopes that the user has authorized. This could be pruned by the user at the confirmation dialog.

Example:

```
curl -v \
-X POST \
-H "Content-Type: application/json" \
"https://oauth.accounts.firefox.com/v1/authorization" \
-d '{
  "client_id": "5901bd09376fadaa",
  "assertion": "<assertion>",
  "state": "1234",
  "scope": "profile:email"
}'
```

#### Response

A valid request will return a 200 response, with JSON containing the `redirect` to follow. It will include the following query parameters:

- `code`: A string that the client will send to the [pubkey][] endpoint. Codes have a configurable expiration value, default is 15 minutes.
- `state`: The same value as was passed as a request parameter.

Example:

```js
{
  "redirect": "https://example.domain/path?foo=bar&code=4ab433e31ef3a7cf7c20590f047987922b5c9ceb1faff56f0f8164df053dd94c&state=1234"
}
```

### POST /v1/token

After having received a [code][authorization], the client sends that code (most
likely a server-side request) to this endpoint, to receive a
longer-lived token that can be used to access attached services for a
particular user.

#### Request Parameters

- `client_id`: The id returned from client registration.
- `client_secret`: The secret returned from client registration.
- `code`: A string that was received from the [authorization][] endpoint.

Example:

```
curl -v \
-X POST \
-H "Content-Type: application/json" \
"https://oauth.accounts.firefox.com/v1/token" \
-d '{
  "client_id": "5901bd09376fadaa",
  "client_secret": "20c6882ef864d75ad1587c38f9d733c80751d2cbc8614e30202dc3d1d25301ff",
  "code": "4ab433e31ef3a7cf7c20590f047987922b5c9ceb1faff56f0f8164df053dd94c"
}'
```

#### Response

A valid request will return a JSON response with these properties:

- `token_type`: The token that will be used for all other authenticated requests.
- `scope`: A string of space-separated permissions that this token has. May differ from requested scopes, since user can deny permissions.
- `token_type`: A string representing the token type. Currently will always be "bearer".

Example:

```js
{
  "token": "e298bbee05d050dd2cb120e7d874793ce969c96f9ab3032017e926a5fa0ca38c",
  "scopes": ["profile:email"],
  "token_type": "gryphon"
}
```

### POST /v1/pubkey

After having received a [code][], the client sends that code (most
likely a server-side request) to this endpoint, along with a unique
[Gryphon public-key][gryphon]. A 200 response means that you may now
sign requests using the corresponding Gryphon secret-key.

This is **experimental**.

#### Request Parameters

- `client_id`: The id returned from client registration.
- `client_secret`: The secret returned from client registration.
- `code`: A string that was received from the [authorization][] endpoint.
- `pubkey`: A 64-length hex string of a public-key used with [Gryphon][gryphon].

Example:

```
curl -v \
-X POST \
-H "Content-Type: application/json" \
"https://oauth.accounts.firefox.com/v1/pubkey" \
-d '{
  "client_id": "5901bd09376fadaa076afacef5251b6a",
  "client_secret": "20c6882ef864d75ad1587c38f9d733c80751d2cbc8614e30202dc3d1d25301ff",
  "code": "4ab433e31ef3a7cf7c20590f047987922b5c9ceb1faff56f0f8164df053dd94c",
  "pubkey": "e298bbee05d050dd2cb120e7d874793ce969c96f9ab3032017e926a5fa0ca38c"
}'
```

#### Response

A valid request will return a JSON response with these properties:

- `scope`: A string of space-separated permissions that this token has. May differ from requested scopes, since user can deny permissions.
- `token_type`: A string representing the token type. Currently will always be "bearer".

Example:

```js
{
  "scopes": ["profile:email"],
  "token_type": "gryphon"
}
```

### POST /v1/verify

Attached services can post tokens to this endpoint to learn about which
user and scopes are permitted for the token.

#### Request Parameters

Must provide 1 of these two, depending on the way you received a token:

- `token`: A 64-length token received from the [token][] endpoint.
- `pubkey`: A 64-length hex string received from a client representing a Gryphon pubkey

Example:

```
curl -v \
-X POST \
-H "Content-Type: application/json" \
"https://oauth.accounts.firefox.com/v1/verify" \
-d '{
  "token": "558f9980ad5a9c279beb52123653967342f702e84d3ab34c7f80427a6a37e2c0"
}'
```

#### Response

A valid request will return JSON with these properties:

- `user`: The uid of the respective user.
- `scopes`: An array of scopes allowed for this pubkey.

Example:

```js
{
  "user": "5901bd09376fadaa076afacef5251b6a",
  "scopes": ["profile:email", "profile:avatar"]
}
```

[client]: #get-v1clientid
[redirect]: #get-v1authorization
[authorization]: #post-v1authorization
[token]: #post-v1token
[pubkey]: #post-v1pubkey
[verify]: #post-v1verify
[gryphon]: #gryphon
