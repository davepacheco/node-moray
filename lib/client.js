/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/client.js: Moray client implementation.  The MorayClient object is the
 * handle through which consumers make RPC requests to a remote Moray server.
 */

var EventEmitter = require('events').EventEmitter;
var net = require('net');
var url = require('url');
var util = require('util');

var assert = require('assert-plus');
var cueball = require('cueball');
var fast = require('fast2');
var jsprim = require('jsprim');
var VError = require('verror');

var buckets = require('./buckets');
var meta = require('./meta');
var objects = require('./objects');
var tokens = require('./tokens');


///--- Default values for function arguments

var dflClientSpareConnections = 4;
var dflClientMaxDnsConcurrency = 3;
var dflClientMaxConnections = 10;
var dflClientConnectRetries = 5;
var dflClientConnectTimeout = 2000;     /* milliseconds */
var dflClientDnsTimeout = 1000;         /* milliseconds */
var dflClientDnsDelayMin = 10;          /* milliseconds */
var dflClientDnsDelayMax = 10000;       /* milliseconds */
var dflClientDelayMin = 1000;           /* milliseconds */
var dflClientDelayMax = Infinity;       /* milliseconds */

var fastNRecentRequests = 100;


///--- Helpers

function emitUnavailable() {
    var emitter = new EventEmitter();
    setImmediate(function () {
        emitter.emit('error', new Error('no active connections'));
    });
    return (emitter);
}

/*
 * This function constructs a set of node-cueball arguments based on legacy
 * properties accepted by the MorayClient constructor.  Those properties
 * included the following required properties:
 *
 *     url               string describing the URL (host and port) to connect to
 *
 * or:
 *
 *     host              string IP address or DNS name for remote Moray service.
 *                       If this is an IP address, then DNS is not used.
 *                       Otherwise, the string is used as a DNS name to find the
 *                       actual IP addresses, and this list of IPs is maintained
 *                       via periodic re-resolution of the DNS name.
 *
 *     port              positive integer: TCP port for remote Moray service
 *
 * and the following optional properties that, if not specified, have defaults
 * that are assumed to be reasonable:
 *
 *     connectTimeout    non-negative, integer number of milliseconds
 *                       to wait for TCP connections to be established
 *
 *     dns (object)      describes DNS behavior
 *
 *     dns.checkInterval non-negative, integer number of milliseconds
 *                       between periodic resolution of DNS names used to keep
 *                       the set of connected IPs up to date.  This is not used
 *                       by cueball any more.
 *
 *     dns.resolvers     array of string IP addresses to use for DNS resolvers
 *
 *     dns.timeout       non-negative, integer number of milliseconds to wait
 *                       for DNS query responses
 *
 *     maxConnections    non-negative, integer number of TCP connections that
 *                       may ever be opened to each IP address used.  If "host"
 *                       is an IP address, then this is the maximum number of
 *                       connections, but if "host" is a DNS name, then there
 *                       may be up to "maxConnections" per remote IP found in
 *                       DNS.
 *
 *     retry (object)    describes a retry policy used for establishing
 *                       connections.  Historically, the behavior with respect
 *                       to this policy was confusing at best: this policy was
 *                       used for establishing TCP connections to remote
 *                       servers, but a second, hardcoded policy was used when
 *                       this first policy was exhausted.  This policy appears
 *                       to have been intended to cover DNS operations as well,
 *                       but was not actually used.  In the current
 *                       implementation, this policy is the one used for TCP
 *                       connection establishment, and callers wanting to
 *                       specify a DNS policy must specify cueball options
 *                       directly rather than using these legacy options.
 *
 *     retry.retries     non-negative, integer number of retry attempts.  It's
 *                       unspecified whether this is the number of attempts or
 *                       the number of retries (i.e., one fewer than the number
 *                       of attempts).  Today, this is interpreted by
 *                       node-cueball.  Historically, this was interpreted by
 *                       the node-backoff.
 *
 *     retry.minTimeout  non-negative, integer number of milliseconds to wait
 *                       after the first operation failure before retrying
 *
 *     retry.maxTimeout  non-negative, integer representing the maximum number
 *                       of milliseconds between retries.  Some form of backoff
 *                       (likely exponential) is used to determine the delay,
 *                       but it will always be between retry.minTimeout and
 *                       retry.maxTimeout.
 *
 * Additional properties were at one time documented, but never used:
 * maxIdleTime and pingTimeout.
 */
function translateLegacyOptions(options)
{
    var cueballOptions, r, u;
    var host, port;

    /*
     * This logic mirrors the legacy behavior of createClient, however
     * unnecessarily complicated.  Specifically:
     *
     *     host     comes from "options.host" if present, and otherwise from
     *              parsing "options.url"
     *
     *     port     comes from "options.port" (as a string or number) if
     *              present.  If "host" was not present and "url" is, then
     *              "port" MAY come from the parsed URL.  Otherwise, the port is
     *              2020.
     */
    if (typeof (options.url) == 'string' && !options.hasOwnProperty('host')) {
        u = url.parse(options.url);
        host = u.hostname;

        if (options.port) {
            port = options.port;
        } else if (url.port) {
            port = url.port;
        } else {
            port = 2020;
        }

        port = parseInt(port, 10);
        assert.ok(!isNaN(port), 'port must be a number');
    } else {
        host = options.host;
        port = options.port;
    }

    assert.string(host, 'options.host');
    assert.number(port, 'options.port');
    assert.optionalNumber(options.maxConnections, 'options.maxConnections');
    assert.optionalNumber(options.connectTimeout, 'options.connectTimeout');
    assert.optionalObject(options.retry, 'options.retry');
    assert.optionalObject(options.dns, 'options.dns');

    cueballOptions = {
        'domain': host,
        'defaultPort': port,
        'maximum': options.maxConnections || dflClientMaxConnections,
        'spares': dflClientSpareConnections,
        'maxDNSConcurrency': dflClientMaxDnsConcurrency,
        'recovery': {}
    };

    /*
     * DNS configuration: The delay and maxDelay values used in the previous
     * implementation were always hardcoded to the default values used here.
     */
    r = cueballOptions.recovery.dns = {
        'retries': dflClientConnectRetries,
        'timeout': dflClientDnsTimeout,
        'delay': dflClientDnsDelayMin,
        'maxDelay': dflClientDnsDelayMax
    };

    if (options.dns) {
        if (Array.isArray(options.dns.resolvers)) {
            assert.arrayOfString(options.dns.resolvers,
                'options.dns.resolvers');
            cueballOptions.resolvers = options.dns.resolvers.slice(0);
        }

        if (options.dns.timeout) {
            assert.number(options.dns.timeout, 'options.dns.timeout');
            assert.ok(options.dns.timeout >= 0,
                'dns timeout must be non-negative');
            r.timeout = options.dns.timeout;
        }
    }

    /*
     * Right or wrong, the legacy behavior was that the timeout for each
     * request never increased.
     */
    r.maxTimeout = r.timeout;

    /*
     * DNS SRV configuration: SRV should fail fast, since it's not widely used
     * yet.
     * XXX-cueball even better would be if cueball tried SRV, AAAA, and A
     * concurrently instead of waiting for them all to fail.
     */
    cueballOptions.recovery.dns_srv = jsprim.deepCopy(
        cueballOptions.recovery.dns);
    cueballOptions.recovery.dns_srv.retries = 0;

    /*
     * Default recovery configuration: we specify a 'default' recovery in
     * the cueball options that will cover both the initial connect attempt
     * and subsequent connect attempts.
     */
    r = cueballOptions.recovery.default = {};
    if (typeof (options.connectTimeout) == 'number') {
        assert.ok(options.connectTimeout >= 0,
            'connect timeout must be non-negative');
        r.timeout = options.connectTimeout;
    } else {
        r.timeout = dflClientConnectTimeout;
    }

    /*
     * As with DNS requests, connection operations historically used a fixed
     * timeout value.
     */
    r.maxTimeout = r.timeout;

    if (options.retry) {
        assert.optionalNumber(options.retry.retries, 'options.retry.retries');
        if (typeof (options.retry.retries) == 'number') {
            r.retries = options.retry.retries;
        } else {
            r.retries = dflClientConnectRetries;
        }

        /*
         * It's confusing, but the "timeout" for a retry policy is
         * really a delay.
         */
        assert.optionalNumber(options.retry.minTimeout,
            'options.retry.minTimeout');
        if (typeof (options.retry.minTimeout) == 'number') {
            r.delay = options.retry.minTimeout;

            if (typeof (options.retry.maxTimeout) == 'number') {
                assert.ok(options.retry.maxTimeout >=
                    options.retry.minTimeout,
                    'retry.maxTimeout must not be smaller ' +
                    'than retry.minTimeout');
                r.maxDelay = options.retry.maxTimeout;
            } else {
                r.delay = options.retry.minTimeout;
                r.maxDelay = Math.max(r.delay, dflClientDelayMax);
            }
        } else if (typeof (options.retry.maxTimeout) == 'number') {
            r.maxDelay = options.retry.maxTimeout;
            r.delay = Math.min(dflClientDelayMin, r.maxDelay);
        } else {
            r.delay = dflClientDelayMin;
            r.maxDelay = dflClientDelayMax;
        }

        assert.number(r.delay);
        assert.number(r.maxDelay);
        assert.ok(r.delay <= r.maxDelay);
    } else {
        r.retries = 0;
        r.delay = 0;
        r.maxDelay = r.delay;
    }

    return (cueballOptions);
}


///--- API

/*
 * Constructor for the moray client.
 *
 * This client uses the cueball module to maintain a pool of TCP connections to
 * the IP addresses associated with a DNS name.  cueball is responsible for
 * DNS resolution (periodically, in the background), maintaining the appropriate
 * TCP connections, and balancing requests across connections.
 *
 * The following named arguments must be specified:
 *
 *     log             bunyan-style logger
 *
 * You must also specify either:
 *
 *     cueballOptions  options used in the constructor of a node-cueball
 *                     ConnectionPool.  See node-cueball documentation.  You
 *                     should not specify the "constructor" or "log" options --
 *                     only the options related to DNS configuration, recovery,
 *                     and connection management.
 *
 * or some combination of legacy options documented with
 * translateLegacyOptions() above.  It's strongly recommended that new consumers
 * use the "cueballOptions" approach because it's much less confusing and allows
 * specifying additional important parameters.
 *
 * You may also specify:
 *
 *     unwrapErrors     If false (the default), Errors emitted by this client
 *                      and RPC requests will contain a cause chain that
 *                      explains precisely what happened.  For example, if an
 *                      RPC fails with SomeError, you'll get back a
 *                      FastRequestError (indicating a request failure) caused
 *                      by a FastServerError (indicating that the failure was on
 *                      the remote server, as opposed to a local or
 *                      transport-level failure) caused by a SomeError.  In this
 *                      mode, you should use VError.findCause(err, 'SomeError')
 *                      to determine whether the root cause was a SomeError.
 *
 *                      If the "unwrapErrors" option is true, then Fast-level
 *                      errors are unwrapped and the first non-Fast error in the
 *                      cause chain is returned.  This is provided primarily for
 *                      compatibility with legacy code that uses err.name to
 *                      determine what kind of Error was returned.  New code
 *                      should prefer VError.findCause() instead.
 *
 *    mustCloseBeforeNormalProcessExit
 *
 *                      If true, then cause the program to crash if it would
 *                      otherwise exit 0 and this client has not been closed.
 *                      This is useful for making sure that client consumers
 *                      clean up after themselves.
 *
 * A sample invocation:
 *
 *     var client = moray.createClient({
 *         'log': bunyan.createLogger({
 *             'name': 'MorayClient',
 *             'level': process.env.LOG_LEVEL || 'debug',
 *             'stream': process.stdout
 *         }),
 *         'cueballOptions': {
 *             'domain': 'moray.mydatacenter.joyent.us',
 *             'defaultPort': 2020,
 *             'spares': 4,
 *             'maximum': 10,
 *             'maxDNSConcurrency': 2,
 *             'recovery': {
 *                 'default': {
 *                     'retries': 10,
 *                     'timeout': 1000,
 *                     'maxTimeout': 10000,
 *                     'delay': 1000,
 *                     'maxDelay': 60000
 *                 }
 *             }
 *         }
 *     });
 */
function MorayClient(options) {
    var self = this;
    var cueballOptions;

    EventEmitter.call(this);

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalBool(options.unwrapErrors, 'options.unwrapErrors');

    /*
     * Many of the client options determine how we configure the cueball module.
     * For compatibility with pre-cueball clients, we accept the old options and
     * translate them into arguments for cueball.  Modern clients may specify
     * cueball options directly, in which case we demand that they have not
     * specified any of these legacy options.
     */
    if (options.hasOwnProperty('cueballOptions')) {
        assert.ok(!options.hasOwnProperty('host'));
        assert.ok(!options.hasOwnProperty('port'));
        assert.ok(!options.hasOwnProperty('connectTimeout'));
        assert.ok(!options.hasOwnProperty('dns'));
        assert.ok(!options.hasOwnProperty('maxConnections'));
        assert.ok(!options.hasOwnProperty('retry'));
        assert.string(options.cueballOptions.domain,
            'options.cueballOptions.domain');
        cueballOptions = jsprim.deepCopy(options.cueballOptions);
    } else {
        cueballOptions = translateLegacyOptions(options);
    }

    assert.string(cueballOptions.domain, 'cueballOptions.domain');
    this.hostLabel = cueballOptions.domain;
    this.log = options.log.child({
        component: 'MorayClient',
        domain: cueballOptions.domain
    }, true);

    this.log.debug(cueballOptions, 'init');
    cueballOptions.constructor = function cueballConstructor(backend) {
        return (self.makeFastClient(backend));
    };
    cueballOptions.log = this.log.child({ 'component': 'cueball' }, true);

    this.cueball = new cueball.ConnectionPool(cueballOptions);
    this.nclaims = 0;
    this.unwrapErrors = options.unwrapErrors ? true : false;
    this.timeConnected = null;

    this.cueball.claim(function onFirstClaim(err, handle, connection) {
        if (err) {
            self.emit('error', new VError(err, 'moray client'));
            return;
        }

        self.timeConnected = new Date();
        self.log.debug('client ready');
        handle.release();
        self.emit('connect');
    });

    if (options.mustCloseBeforeNormalProcessExit) {
        this.onprocexit = function processExitCheck(code) {
            if (code === 0) {
                throw (new Error('process exiting before moray client closed'));
            }
        };
        process.on('exit', this.onprocexit);
    } else {
        this.onprocexit = null;
    }

    /*
     * This getter is provided for historical reasons.  It's not a great
     * interface.  It's intrinsically racy (i.e., the state may change as soon
     * as the caller has checked it), and it doesn't reflect much about the
     * likelihood of a request succeeding.  It's tempting to simply always
     * report "true" so that clients that might be tempted to avoid making a
     * request when disconnected would just go ahead and try it (which will fail
     * quickly if we are disconnected anyway).  But we settle on the compromise
     * position of reporting only whether we've _ever_ had a connection.  This
     * accurately reflects what many clients seem interested in, which is
     * whether we've set up yet.
     */
    this.__defineGetter__('connected', function () {
        return (self.timeConnected !== null);
    });
}

util.inherits(MorayClient, EventEmitter);

/**
 * Shuts down all connections and closes this client down.
 */
MorayClient.prototype.close = function close() {
    var self = this;

    if (this.onprocexit !== null) {
        process.removeListener('exit', this.onprocexit);
        this.onprocexit = null;
    }

    if (this.nclaims > 0) {
        /* Cueball actually blows up on this condition. */
        this.log.warn({ 'nclaims': this.nclaims },
            'shutting down with outstanding claims');
    }

    this.cueball.stop();
    setImmediate(function onCloseDone() {
        /*
         * By this point, cueball has destroyed all outstanding connections, and
         * we should have failed any outstanding requests and released the
         * underlying handles.  (Actually, as of this writing, cueball requires
         * that there be no claims at the point where we called stop() above.
         * But it could relax this restriction, and this assertion should still
         * hold.)
         */
        assert.ok(self.nclaims === 0);
        self.emit('close');
    });
};

/**
 * Creates a Bucket
 *
 * `cfg` allows you to pass in index information, as well as pre/post triggers.
 * See https://mo.joyent.com/docs/moray/master/#CreateBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} cfg  - configuration
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.createBucket = function createBucket(b, cfg, opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        buckets.createBucket(rpcctx, b, cfg, opts,
            this.makeReleaseCb(rpcctx, cb));
};


/**
 * Fetches a Bucket
 *
 * See https://mo.joyent.com/docs/moray/master/#GetBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.getBucket = function getBucket(b, opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        buckets.getBucket(rpcctx, b, opts, this.makeReleaseCb(rpcctx, cb));
};


/**
 * Lists all buckets
 *
 * See https://mo.joyent.com/docs/moray/master/#ListBucket for more info.
 *
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.listBuckets = function listBuckets(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }

    var rpcctx = this.makeRpcContextForCallback(cb);

    if (rpcctx)
        buckets.listBuckets(rpcctx, opts, this.makeReleaseCb(rpcctx, cb));
};


/**
 * Updates an existing Bucket
 *
 * `cfg` allows you to pass in index information, as well as pre/post triggers.
 * See https://mo.joyent.com/docs/moray/master/#UpdateBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} cfg  - configuration
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.updateBucket = function updateBucket(b, cfg, opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        buckets.updateBucket(rpcctx, b, cfg, opts,
            this.makeReleaseCb(rpcctx, cb));
};


/**
 * Deletes a Bucket
 *
 * See https://mo.joyent.com/docs/moray/master/#DeleteBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.deleteBucket = function deleteBucket(b, opts, cb) {
    assert.string(b, 'bucket');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        buckets.deleteBucket(rpcctx, b, opts, this.makeReleaseCb(rpcctx, cb));
};
MorayClient.prototype.delBucket = MorayClient.prototype.deleteBucket;


/**
 * Creates or replaces a Bucket.
 *
 * Note that this is actually just a client shim, and simply calls
 * get, followed by create || update.  This is not transactional,
 * and there are races, so you probably just want to call this once
 * at startup in your code.
 *
 * @param {String} b    - Bucket name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.putBucket = function putBucket(b, cfg, opts, cb) {
    assert.string(b, 'bucket');
    assert.object(cfg, 'config');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        buckets.putBucket(rpcctx, b, cfg, opts, this.makeReleaseCb(rpcctx, cb));
};

/**
 * Idempotently Creates or Replaces an Object.
 *
 * See https://mo.joyent.com/docs/moray/master/#PutObject for more info.
 *
 * @param {String} b    - Bucket name
 * @param {String} k    - Key name
 * @param {Object} v    - Value
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.putObject = function putObject(b, k, v, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(k, 'key');
    assert.object(v, 'value');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.putObject(rpcctx, b, k, v, opts,
            this.makeReleaseCb(rpcctx, cb));
};


/**
 * Fetches an Object
 *
 * See https://mo.joyent.com/docs/moray/master/#GetObject for more info.
 *
 * @param {String} b    - Bucket name
 * @param {String} k    - Key name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.getObject = function getObject(b, k, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(k, 'key');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.getObject(rpcctx, b, k, opts, this.makeReleaseCb(rpcctx, cb));
};


/**
 * Deletes an Object
 *
 * See https://mo.joyent.com/docs/moray/master/#DeleteObject for more info.
 *
 * @param {String} b    - Bucket name
 * @param {String} k    - Key name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.deleteObject = function deleteObject(b, k, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(k, 'key');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.deleteObject(rpcctx, b, k, opts,
            this.makeReleaseCb(rpcctx, cb));
};
MorayClient.prototype.delObject = MorayClient.prototype.deleteObject;


/**
 * Finds object matching a given filter
 *
 * See https://mo.joyent.com/docs/moray/master/#FindObjects for more info.
 *
 * @param {String} b      - Bucket name
 * @param {String} f      - Object filter
 * @param {Object} opts   - request parameters
 * @return {EventEmitter} - listen for 'record', 'end' and 'error'
 */
MorayClient.prototype.findObjects = function findObjects(b, f, opts) {
    assert.string(b, 'bucket');
    assert.string(f, 'filter');
    assert.optionalObject(opts, 'options');

    var rpcctx = this.makeRpcContextForEmitter();
    if (rpcctx) {
        var rv = objects.findObjects(rpcctx, b, f, (opts || {}));
        this.releaseWhenDone(rpcctx, rv);
        return (rv);
    }
    return (emitUnavailable());
};
MorayClient.prototype.find = MorayClient.prototype.findObjects;


/**
 * Idempotently Creates or Replaces a set of Object.
 *
 * See https://mo.joyent.com/docs/moray/master/#Batch for more info.
 *
 * @param {Array} requests - {bucket, key, value} tuples
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.batch = function batch(requests, opts, cb) {
    assert.arrayOfObject(requests, 'requests');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.batch(rpcctx, requests, opts, this.makeReleaseCb(rpcctx, cb));
};


/**
 * Updates a set of object attributes.
 *
 * See https://mo.joyent.com/docs/moray/master/#UpdateObjects for more info.
 *
 * @param {String} bucket - bucket
 * @param {Object} fields - attributes to update (must be indexes)
 * @param {String} filter - update objects matching this filter
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.updateObjects = function update(b, f, f2, opts, cb) {
    assert.string(b, 'bucket');
    assert.object(f, 'fields');
    assert.string(f2, 'filter');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.updateObjects(rpcctx, b, f, f2, opts,
            this.makeReleaseCb(rpcctx, cb));
};


/**
 * Deletes a group of objects.
 *
 * See https://mo.joyent.com/docs/moray/master/#DeleteMany for more info.
 *
 * @param {String} bucket - bucket
 * @param {String} filter - update objects matching this filter
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.deleteMany = function deleteMany(b, f, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(f, 'filter');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.deleteMany(rpcctx, b, f, opts, this.makeReleaseCb(rpcctx, cb));
};


/**
 * Request reindexing of stale rows.
 *
 * Returns a count of successfully processed rows.  Once the processed count
 * reaches zero, all rows will be properly reindexed.
 *
 * @param {String} bucket - bucket
 * @param {String} count  - max objects to reindex
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.reindexObjects = function reindexObjects(b, c, opts, cb) {
    assert.string(b, 'bucket');
    assert.number(c, 'count');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        objects.reindexObjects(rpcctx, b, c, opts,
            this.makeReleaseCb(rpcctx, cb));
};


/*
 * Gets the set of tokens from moray.
 *
 * See https://mo.joyent.com/docs/moray/master/#UpdateObjects for more info.
 *
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.getTokens = function getTokens(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        tokens.getTokens(rpcctx, opts, this.makeReleaseCb(rpcctx, cb));
};


/**
 * Performs a ping check against the server.
 *
 * Note that because the MorayClient is pooled and connects to all IPs in
 * a RR-DNS set, this actually just tells you that _one_ of the servers is
 * responding, not that all are.
 *
 * In most cases, you probably want to send in '{deep: true}' as options
 * so a DB-level check is performed on the server.
 *
 * @param {Object} opts   - request parameters
 * @return {EventEmitter} - listen for 'record', 'end' and 'error'
 */
MorayClient.prototype.ping = function _ping(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        meta.ping(rpcctx, opts, this.makeReleaseCb(rpcctx, cb));
};

/**
 * Query the API version of the server.
 *
 * Do not use this function except for reporting version numbers to humans.  See
 * the comment in meta.versionInternal().
 *
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.versionInternal = function _version(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var rpcctx = this.makeRpcContextForCallback(cb);
    if (rpcctx)
        meta.versionInternal(rpcctx, opts, this.makeReleaseCb(rpcctx, cb));
};

/**
 * Performs a raw SQL operation against the server.
 *
 * For the love of all this good in this earth, please only use this method
 * at the utmost of need.  In almost every case this is used, it's used for
 * nefarious reasons.
 *
 * The only intended uses of this are for edge cases that require custom
 * "serial" tables, et al, in the database (like UFDS changelog).  You
 * absolutely do not ever need to use this if put/get/del/find works for you.
 *
 * @param {String} stmt   - SQL Statement
 * @param {Array} vals    - Values (if SQL statement has $1 etc. in it)
 * @param {Object} opts   - Request Options
 * @return {EventEmitter} - listen for 'record', 'end' and 'error'
 */
MorayClient.prototype.sql = function _sql(stmt, vals, opts) {
    var rv;

    switch (arguments.length) {
    case 0:
        throw new TypeError('statement (String) required');
    case 1:
        assert.string(stmt, 'statement');
        vals = [];
        opts = {};
        break;
    case 2:
        assert.string(stmt, 'statement');
        if (!Array.isArray(vals)) {
            assert.object(vals, 'options');
            opts = vals;
            vals = [];
        } else {
            opts = {};
        }
        break;
    case 3:
        assert.string(stmt, 'statement');
        assert.ok(Array.isArray(vals));
        assert.object(opts, 'options');
        break;
    default:
        throw new Error('too many arguments');
    }

    var rpcctx = this.makeRpcContextForEmitter();
    if (rpcctx) {
        rv = meta.sql(rpcctx, stmt, vals, opts);
        this.releaseWhenDone(rpcctx, rv);
        return (rv);
    }
    return (emitUnavailable());
};


MorayClient.prototype.toString = function toString() {
    var str = util.format('[object MorayClient<host=%s>]', this.hostLabel);
    return (str);
};

/*
 * Internal function that attempts to claim a connection from cueball and
 * returns an Error if that fails.
 */
MorayClient.prototype.claimSyncWithoutError = function ()
{
    var claim;

    try {
        claim = this.cueball.claimSync();
    } catch (ex) {
        return (new VError(ex, 'failed to claim connection'));
    }

    return (claim);
};

/*
 * Internal function that returns a context used for RPC operations (called a
 * "client" elsewhere in the code for historical reasons) for a callback-based
 * RPC call.  If no client is available, this function returns null *and*
 * schedules an asynchronous invocation of the given callback with a suitable
 * error.
 */
MorayClient.prototype.makeRpcContextForCallback =
    function makeRpcContextForCallback(callback) {
    var claim;

    assert.func(callback, 'callback');
    claim = this.claimSyncWithoutError();
    if (claim instanceof Error) {
        setImmediate(callback, claim);
        return (null);
    }

    return (this.makeRpcContext(claim));
};

/*
 * Internal function that returns a context used for RPC operations (called a
 * "client" elsewhere in the code for hsitorical reasons) for an
 * event-emitter-based RPC call.  If no client is available, this function
 * returns null and the caller is responsible for propagating the error to its
 * caller.
 */
MorayClient.prototype.makeRpcContextForEmitter =
    function makeRpcContextForEmitter() {
    var claim;

    claim = this.claimSyncWithoutError();
    if (claim instanceof Error) {
        /* The caller knows that this means there are no connections. */
        return (null);
    }

    return (this.makeRpcContext(claim));
};

/*
 * Internal function that takes a cueball claim and turns it into an RPC context
 * used elsewhere in the code.
 */
MorayClient.prototype.makeRpcContext = function (claim) {
    assert.object(claim);
    assert.ok(!(claim instanceof Error));
    assert.object(claim.handle);
    assert.object(claim.connection);
    assert.ok(claim.connection instanceof FastClientBackend);
    this.nclaims++;
    return (new MorayRpcContext({
        'backend': claim.connection,
        'cueballHandle': claim.handle,
        'unwrapErrors': this.unwrapErrors
    }));
};

/*
 * Given an RPC context and a user callback, return a callback that will
 * release the underlying RPC context and then invoke the user callback with the
 * same arguments.
 */
MorayClient.prototype.makeReleaseCb = function makeReleaseCb(rpcctx, cb) {
    var self = this;
    return (function onCallbackRpcComplete() {
        var args = Array.prototype.slice.call(arguments);
        self.clientRelease(rpcctx);
        cb.apply(null, args);
    });
};

/*
 * Given an RPC context and an event emitter, return a callback that will
 * release the underlying RPC context when the event emitter emits "end" or
 * "error".  This is the EventEmitter analog of makeReleaseCb.
 */
MorayClient.prototype.releaseWhenDone = function releaseOnEnd(rpcctx, emitter)
{
    var self = this;
    var done = false;

    assert.object(rpcctx);
    assert.object(emitter);
    assert.ok(emitter instanceof EventEmitter);

    function onEmitterRpcComplete() {
        assert.ok(!done);
        done = true;
        self.clientRelease(rpcctx);
    }

    emitter.on('error', onEmitterRpcComplete);
    emitter.on('end', onEmitterRpcComplete);
};

/*
 * Internal function for releasing an RPC context (that is, releasing the
 * underlying cueball claim).
 */
MorayClient.prototype.clientRelease = function clientRelease(rpcctx)
{
        assert.ok(this.nclaims > 0);
        this.nclaims--;
        rpcctx.release();
};

/*
 * Given a cueball "backend", return a cueball-compatible connection.  The
 * We actually just return a plain TCP connection off which we've hung a
 * FastClient wrapped over the connection.  That's kind of dodgy.  We could
 * instead create a wrapper object that looks like a TCP connection
 * (implementing the same methods and emitting the same events), but which has a
 * reference to our fast client.
 */
MorayClient.prototype.makeFastClient = function makeFastClient(backend) {
    var csock, fastClient;

    assert.string(backend.name, 'backend.name');
    assert.string(backend.address, 'backend.address');
    assert.number(backend.port, 'backend.port');

    csock = net.createConnection(backend.port, backend.address);
    fastClient = new fast.FastClient({
        'nRecentRequests': fastNRecentRequests,
        'transport': csock,
        'log': this.log.child({
            'component': 'FastClient',
            'backendName': backend.name,
            'backendAddress': backend.address + ':' + backend.port
        })
    });

    return (new FastClientBackend({
        'socket': csock,
        'log': this.log,
        'fastClient': fastClient
    }));
};


/*
 * The FastClientBackend manages a single FastClient in the context of a cueball
 * connection pool.  It's not obvious at first why this class needs to exist,
 * but here's why:
 *
 *     o The backend object that cueball manages needs to resemble a Node
 *       socket.  In particular, it needs to emit 'error' when the socket has
 *       failed so that cueball knows that the socket is dead.  It also needs to
 *       support destroy() for when cueball decides to terminate a connection,
 *       and a few other methods.  Importantly, we may want this object to emit
 *       'error' even when there hasn't been a socket error (e.g., because of a
 *       protocol error).
 *
 *     o Whatever backend object cueball manages, that's what we get back when
 *       we ask cueball for a connection via claimSync().  But the object we
 *       actually want to use is not the underlying Node Socket, but the
 *       FastClient that's been instantiated atop it.
 *
 * This class presents a Node Socket-like interface to cueball, but also keeps
 * track of the FastClient built atop the Socket.
 */
function FastClientBackend(args)
{
    assert.object(args);
    assert.object(args.fastClient);
    assert.object(args.log);
    assert.object(args.socket);

    EventEmitter.call(this);

    this.fcb_client = args.fastClient;
    this.fcb_log = args.log;
    this.fcb_socket = args.socket;
    this.fcb_error = null;

    /* XXX-cueball need to figure out exactly what cueball expects here. */
    this.fcb_socket.on('connect', this.emit.bind(this, 'connect'));
    this.fcb_client.on('error', this.onError.bind(this));
    this.fcb_socket.on('error', this.onError.bind(this));
}

util.inherits(FastClientBackend, EventEmitter);

FastClientBackend.proxyMethod = function proxyMethod(methodname) {
    return (function () {
        var socket, args;
        assert.ok(this instanceof FastClientBackend);
        assert.object(this.fcb_socket);
        assert.func(this.fcb_socket[methodname]);
        socket = this.fcb_socket;
        args = Array.prototype.slice.call(arguments);
        return (socket[methodname].apply(socket, args));
    });
};

FastClientBackend.prototype.destroy = FastClientBackend.proxyMethod('destroy');
/* XXX-cueball */
FastClientBackend.prototype.unref = FastClientBackend.proxyMethod('unref');
FastClientBackend.prototype.ref = FastClientBackend.proxyMethod('ref');

/*
 * Invoked when the underlying client or socket emits an error.  Note that the
 * socket may emit an error without a client error, or the client may emitted an
 * error without a socket error, or both may emit an error for the same
 * underlying event.  However, we should only emit one error.
 */
FastClientBackend.prototype.onError = function (err) {
    if (this.fcb_error === null) {
        this.fcb_error = err;
        this.emit('error', err);
    }
};


/*
 * A MorayRpcContext represents the context of a Moray RPC call.  This is mostly
 * a container for a FastClient and a corresponding cueball claim on that
 * client, but provides related helper methods.
 */
function MorayRpcContext(args) {
    assert.object(args);
    assert.object(args.backend);
    assert.object(args.cueballHandle);
    assert.bool(args.unwrapErrors);

    this.fch_backend = args.backend;
    this.fch_cueball_handle = args.cueballHandle;
    this.fch_unwrap = args.unwrapErrors;
}

MorayRpcContext.prototype.fastClient = function ()
{
    return (this.fch_backend.fcb_client);
};

MorayRpcContext.prototype.release = function ()
{
    this.fch_cueball_handle.release();
};

MorayRpcContext.prototype.unwrapErrors = function ()
{
    return (this.fch_unwrap);
};


///--- Exports

module.exports = {
    Client: MorayClient
};
