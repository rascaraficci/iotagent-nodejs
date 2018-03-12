"use strict";

/*
 * Authentication related helper functions and utils
 */


/**
 * [getToken description]
 * @param  {[string]} tenant dojot tenant for which the token should be valid for
 * @return {[string]}        JWT token to be used in requests
 */
module.exports = function getToken(tenant) {
  const payload = {'service': tenant, 'username': 'iotagent'};
  return (new Buffer('jwt schema').toString('base64')) + '.'
         + (new Buffer(JSON.stringify(payload)).toString('base64')) + '.'
         + (new Buffer('dummy signature').toString('base64'));
}
