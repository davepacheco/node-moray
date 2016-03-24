/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');
var VError = require('verror');


///--- API

function childLogger(client, options) {
    var log = client.fch_backend.fcb_log.child({
        req_id: (options || {}).req_id || libuuid.create()
    }, true);

    return (log);
}


function shallowClone(obj) {
    if (!obj) {
        return (obj);
    }
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return (copy);
}


function simpleCallback(opts) {
    assert.object(opts, 'options');
    assert.func(opts.callback, 'options.callback');
    assert.object(opts.log, 'options.log');
    assert.string(opts.name, 'options.name');
    assert.object(opts.request, 'options.request');

    function callback(err) {
        if (err) {
            opts.log.debug(err, '%s failed', opts.name);
            opts.callback(err);
            return;
        }

        opts.log.debug('%s done', opts.name);
        opts.request.removeAllListeners('end');
        opts.request.removeAllListeners('error');
        opts.callback();
    }

    return (callback);
}

function rpcCommonNoData(args, callback) {
    assert.func(callback);
    rpcCommonBufferData(args, function (err, data) {
        if (!err && data.length > 0) {
            err = new VError('bad server response: expected 0 data messages, ' +
                'found %d\n', data.length);
        }

        callback(err);
    });
}

/*
 * XXX should logging and timeouth andling be moved into the FastClient so that
 * this function doesn't need to exist at the Moray level at all?
 * XXX the fast client could also provide NoData and BufferData interfaces
 */
function rpcCommon(args, callback) {
    var log, rpcmethod, req, cb;
    var timeoutms = null;
    var timeout = null;

    assert.object(args, 'args');
    assert.object(args.client, 'args.client');
    assert.string(args.rpcmethod, 'args.rpcmethod');
    assert.array(args.rpcargs, 'args.rpcargs');
    assert.object(args.log, 'args.log');
    assert.optionalNumber(args.timeout, 'args.timeout');
    assert.func(callback);

    if (args.hasOwnProperty('timeout')) {
        assert.ok(args.timeout > 0, 'args.timeout must be positive');
        timeoutms = args.timeout;
    }

    log = args.log;
    cb = onceFatal(callback);
    rpcmethod = args.rpcmethod;
    log.debug({ 'rpcargs': args.rpcargs }, rpcmethod + ': entered');
    req = args.client.fastClient().rpc({
        'rpcmethod': rpcmethod,
        'rpcargs': args.rpcargs
    });

    req.once('end', function () {
        /* XXX don't want to log this if next level up is going to fail */
        if (timeout !== null) {
            clearTimeout(timeout);
        }
        log.debug(rpcmethod + ': done');
        cb(null);
    });

    req.once('error', function (err) {
        if (timeout !== null) {
            clearTimeout(timeout);
        }
        log.debug(err, rpcmethod + ': failed');
        cb(err);
    });

    if (timeoutms !== null) {
        timeout = setTimeout(function onTimeout() {
            timeout = null;
            log.debug(rpcmethod + ': timed out (aborting request)');
            /* XXX abort should probably let you specify an error? */
            req.abort();
        }, timeoutms);
    }

    return (req);
}

function rpcCommonBufferData(args, callback) {
    var req, rpcmethod, log, data;

    assert.func(callback, 'callback');
    req = rpcCommon(args, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, data);
        }
    });

    rpcmethod = args.rpcmethod;
    log = args.log;
    data = [];
    req.on('data', function (obj) {
        log.debug({ 'message': obj }, rpcmethod + ': received object');
        data.push(obj);
    });

    return (req);
}

function onceFatal(callback) {
    assert.func(callback);
    var done = false;
    return (function () {
        var args;

        if (done) {
            throw (new Error('invoked callback more than once'));
        }

        done = true;
        args = Array.prototype.slice.call(arguments);
        callback.apply(null, args);
    });
}


///--- Exports

module.exports = {
    childLogger: childLogger,
    shallowClone: shallowClone,
    rpcCommon: rpcCommon,
    rpcCommonNoData: rpcCommonNoData,
    rpcCommonBufferData: rpcCommonBufferData,
    onceFatal: onceFatal,
    simpleCallback: simpleCallback
};
