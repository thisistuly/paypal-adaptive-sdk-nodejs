var https = require('https'),
  util = require('util'),
  crypto = require('crypto'),
  _ = require('underscore');

var adaptiveAccountsMethods = [
  'AddBankAccount',
  'AddPaymentCard',
  'CheckComplianceStatus',
  'CreateAccount',
  'GetUserAgreement',
  'GetVerifiedStatus',
  'SetFundingSourceConfirmed',
  'UpdateComplianceStatus'
];

var adaptivePaymentsMethods = [
  'CancelPreapproval',
  'ConvertCurrency',
  'ExecutePayment',
  'GetFundingPlans',
  'GetShippingAddresses',
  'PreapprovalDetails',
  'SetPaymentOptions'
];

var permissionsMethods = [
  'CancelPermissions',
  'GetAccessToken',
  'GetAdvancedPersonalData',
  'GetBasicPersonalData',
  'GetPermissions',
  'RequestPermissions'
];

function merge(a, b) {
  for (var p in b) {
    try {
      if (b[p].constructor === Object) {
        a[p] = merge(a[p], b[p]);
      }
      else {
        a[p] = b[p];
      }
    }
    catch (e) {
      a[p] = b[p];
    }
  }
  return a;
}

function defaultPayload() {
  return {
    requestEnvelope: {
      errorLanguage: 'en_US',
      detailLevel: 'ReturnAll'
    }
  };
}

function httpsPost(options, callback) {
  options.method = 'POST';
  options.headers = options.headers || {};

  var data = (typeof options.data !== 'string') ? JSON.stringify(options.data) : options.data;

  options.headers['Content-Length'] = Buffer.byteLength(data);

  var req = https.request(options);

  req.on('response', function (res) {
    var response = '';
    //do not setEndcoding with browserify
    if (res.setEncoding) {
      res.setEncoding('utf8');
    }

    res.on('data', function (chunk) {
      response += chunk;
    });

    res.on('end', function () {
      return callback(null, {
        statusCode: res.statusCode,
        body: response
      });
    });
  });

  req.on('error', function (e) {
    callback(e);
  });

  if (data) {
    req.write(data);
  }

  req.end();
}

var Paypal = function (config) {
  if (!config) throw new Error('Config is required');
  if (!config.userId) throw new Error('Config must have userId');
  if (!config.password) throw new Error('Config must have password');
  if (!config.signature) throw new Error('Config must have signature');
  if (!config.appId && !config.sandbox) throw new Error('Config must have appId');

  var defaultConfig = {
    requestFormat: 'JSON',
    responseFormat: 'JSON',
    sandbox: false,
    productionHostname: 'svcs.paypal.com',
    sandboxHostname: 'svcs.sandbox.paypal.com',
    appId: 'APP-80W284485P519543T',
    approvalUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_ap-payment&paykey=%s',
    sandboxApprovalUrl: 'https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_ap-payment&paykey=%s',
    preapprovalUrl: 'https://www.paypal.com/webscr?cmd=_ap-preapproval&preapprovalkey=%s',
    sandboxPreapprovalUrl: 'https://www.sandbox.paypal.com/webscr?cmd=_ap-preapproval&preapprovalkey=%s'
  };

  this.config = merge(defaultConfig, config);
};

Paypal.prototype.callApi = function (apiMethod, data, callback) {
  var config = this.config;

  var headers = {
    'X-PAYPAL-SECURITY-USERID': config.userId,
    'X-PAYPAL-SECURITY-PASSWORD': config.password,
    'X-PAYPAL-SECURITY-SIGNATURE': config.signature,
    'X-PAYPAL-APPLICATION-ID': config.appId,
    'X-PAYPAL-REQUEST-DATA-FORMAT': config.requestFormat,
    'X-PAYPAL-RESPONSE-DATA-FORMAT': config.responseFormat
  };

  if (data.token && data.token_secret) {
    var url = 'https://' + (this.config.sandbox ? this.config.sandboxHostname : this.config.productionHostname) + '/' + apiMethod;
    headers['X-PAYPAL-AUTHORIZATION'] = this.genSignature(this.config.userId, this.config.password, data.token, data.token_secret, url);
    delete data.token;
    delete data.token_secret;
  }

  data = merge(defaultPayload(), data);

  var options = {
    hostname: config.sandbox ? config.sandboxHostname : config.productionHostname,
    port: 443,
    path: '/' + apiMethod,
    data: data,
    headers: headers
  };

  if (config.sandboxEmailAddress)
    options.headers['X-PAYPAL-SANDBOX-EMAIL-ADDRESS'] = config.sandboxEmailAddress;

  if (config.deviceIpAddress)
    options.headers['X-PAYPAL-DEVICE-IPADDRESS'] = config.deviceIpAddress;

  httpsPost(options, function (error, response) {
    if (error) {
      return callback(error);
    }

    var body = response.body;
    var statusCode = response.statusCode;

    if (config.responseFormat === 'JSON') {
      try {
        body = JSON.parse(body);
      }
      catch (e) {
        var err = new Error('Invalid JSON Response Received');
        err.response = body;
        err.httpStatusCode = response.statusCode;
        return callback(err);
      }
    }

    if (statusCode < 200 || statusCode >= 300) {
      error = new Error('Response Status: ' + statusCode);
      error.response = body;
      error.httpStatusCode = statusCode;
      return callback(error);
    }

    body.httpStatusCode = statusCode;

    if (/^(Success|SuccessWithWarning)$/.test(body.responseEnvelope.ack)) {
      callback(null, body);
    }
    else {
      var err = new Error('Response ack is ' + body.responseEnvelope.ack + '. Check the response for more info');
      return callback(err, body);
    }
  });
};

// Paypal Adaptive Payments API methods
Paypal.prototype.getPaymentOptions = function (payKey, callback) {
  if (!payKey) {
    return callback(new Error('Required "payKey"'));
  }

  var data = defaultPayload();
  data.payKey = payKey;

  this.callApi('AdaptivePayments/GetPaymentOptions', data, callback);
};

Paypal.prototype.paymentDetails = function (params, callback) {
  if (!params.payKey && !params.transactionId && !params.trackingId) {
    return callback(new Error('Required "payKey" or "transactionId" or "trackingId" on first param'));
  }

  var data = merge(defaultPayload(), params);

  this.callApi('AdaptivePayments/PaymentDetails', data, callback);
};

Paypal.prototype.pay = function (data, callback) {
  var config = this.config;

  this.callApi('AdaptivePayments/Pay', data, function (err, res) {
    if (err) {
      return callback(err, res);
    }

    if (res.paymentExecStatus === 'CREATED') {
      var url = config.sandbox ? config.sandboxApprovalUrl : config.approvalUrl;
      res.paymentApprovalUrl = util.format(url, res.payKey);
    }

    return callback(null, res);
  });
};

Paypal.prototype.preapproval = function (data, callback) {
  var config = this.config;

  this.callApi('AdaptivePayments/Preapproval', data, function (err, res) {
    if (err) {
      return callback(err, res);
    }

    if (res.preapprovalKey) {
      var url = config.sandbox ? config.sandboxPreapprovalUrl : config.preapprovalUrl;
      res.preapprovalUrl = util.format(url, res.preapprovalKey);
    }

    return callback(null, res);
  });
};

Paypal.prototype.refund = function (params, callback) {
  if (!params.payKey && !params.transactionId && !params.trackingId) {
    return callback(new Error('Required "payKey" or "transactionId" or "trackingId" on first param'));
  }

  var data = merge(defaultPayload(), params);

  this.callApi('AdaptivePayments/Refund', data, callback);
};

adaptivePaymentsMethods.forEach(function (method) {
  var prototypeMethodName = method.charAt(0).toLowerCase() + method.slice(1);
  var apiMethodName = 'AdaptivePayments/' + method;
  Paypal.prototype[prototypeMethodName] = function (data, callback) {
    this.callApi(apiMethodName, data, callback);
  };
});

adaptiveAccountsMethods.forEach(function (method) {
  var prototypeMethodName = method.charAt(0).toLowerCase() + method.slice(1);
  var apiMethodName = 'AdaptiveAccounts/' + method;
  Paypal.prototype[prototypeMethodName] = function (data, callback) {
    this.callApi(apiMethodName, data, callback);
  };
});

permissionsMethods.forEach(function (method) {
  var prototypeMethodName = method.charAt(0).toLowerCase() + method.slice(1);
  var apiMethodName = 'Permissions/' + method;
  Paypal.prototype[prototypeMethodName] = function (data, callback) {
    this.callApi(apiMethodName, data, callback);
  };
});



Paypal.prototype.genSignature = function (username, password, token, token_secret, url, timestamp) {
  var timestamp = timestamp ||  (Date.now() / 1000 | 0);
  var key = [
    this.paypalEncode(password),
    this.paypalEncode(token_secret)
  ].join('&').replace(/%([0-9A-F][0-9A-F])/g, function (v) {
    return v.toLowerCase()
  });

  var params = {
    'oauth_consumer_key': username,
    'oauth_signature_method': 'HMAC-SHA1',
    'oauth_timestamp': timestamp,
    'oauth_token': token,
    'oauth_version': '1.0',
  };

  var sortedQueryString = _.map(params, function (o, k) {
    return k + '=' + o
  }).join('&');

  var baseString = [
    'POST',
    this.paypalEncode(url),
    this.paypalEncode(sortedQueryString)
  ].join('&').replace(/%([0-9A-F][0-9A-F])/g, function (v) {
    return v.toLowerCase()
  });

  var oAuthSignature = crypto.createHmac('SHA1', key).update(baseString).digest('base64');
  return "token=" + token + ",signature=" + oAuthSignature + ",timestamp=" + timestamp;
};

Paypal.prototype.paypalEncode = function (str) {
  return encodeURIComponent(str).replace(/\./g, '%2E').replace(/-/g, '%2D');
}

module.exports = Paypal;
