/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * loop.test.js: this test program runs basic PutObject/GetObject queries in a
 * loop with modest concurrency.  By default, it fails if any request fails or
 * takes too long.  You can configure this test to ignore explicit errors in
 * order to test client behavior in the face of server restarts.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var libuuid = require('libuuid');
var vasync = require('vasync');
var VError = require('verror');

var moray = require('../lib');


///--- Globals

var client, queue;
var noperations = 25000;            /* total operations to complete */
var concurrency = 5;                /* concurrency of operations */
var timeout = 60000;                /* per-operation timeout */
var ignoreExplicitErrors = false;   /* ignore explicit moray failures */
var nokay = 0;                      /* count of successful operations */
var nfailed = 0;                    /* count of total failures */
var nbyerror = {};                  /* count of failures by error name */
var bucket = 'moray_loop_test_js_' + libuuid.create().substr(0, 7);
var bucketconfig = {
    index: {
        foo: {
            type: 'string'
        }
    }
};


///--- Mainline

function main() {
    var url, clientparams;

    if (process.argv[2] == '--ignore-explicit-errors') {
        console.log('ignoring explicit errors');
        ignoreExplicitErrors = true;
    }

    if (process.env['MORAY_URL']) {
        url = process.env['MORAY_URL'];
        console.log('using url from environment: %s', url);
    } else {
        console.error('MORAY_URL must be specified in the environment.');
        process.exit(1);
    }

    clientparams = {
        url: url,
        mustCloseBeforeNormalProcessExit: true,
        log: bunyan.createLogger({
            name: 'moray_client',
            level: process.env.LOG_LEVEL || 'fatal',
            stream: process.stdout
        })
    };

    client = moray.createClient(clientparams);

    queue = vasync.queuev({
        'concurrency': concurrency,
        'worker': makeOneRequest
    });

    client.once('connect', onClientReady);
}

/*
 * Invoked upon successful connection to Moray to enqueue however many
 * operations we intend to complete.  When we've finished them all, invokes
 * cleanup().
 */
function onClientReady() {
    console.log('creating test bucket: %s', bucket);
    client.putBucket(bucket, bucketconfig, function (init_err) {
        var i, opstate;

        assert.ifError(init_err);

        for (i = 0; i < noperations; i++) {
            opstate = {
                'op_key': libuuid.create(),
                'op_value': { 'foo': '' + 1 },
                'op_timeout': null,
                'op_error': null
            };

            queue.push(opstate);
        }

        queue.on('end', function () {
            console.log('all operations completed');
            cleanup();
        });

        queue.close();
    });
}

/*
 * Invoked as a vasync queue callback to complete a single "operation", which
 * consists of a PutObject and GetObject pair.  If this hasn't completed in 60
 * seconds, we assume that we dropped a request and bail out.
 */
function makeOneRequest(opstate, qcallback) {
    opstate.op_timeout = setTimeout(function () {
        console.error('operation did not complete within %d milliseconds',
            timeout);
        throw (new Error('operation timeout'));
    }, timeout);

    client.putObject(bucket, opstate.op_key, opstate.op_value,
        { 'noCache': true }, function (err) {
        if (ignoreExplicitErrors && err) {
            opstate.op_error = err;
            finishRequest(opstate, qcallback);
            return;
        }

        assert.ifError(err);
        client.getObject(bucket, opstate.op_key, { 'noCache': true },
            function (geterr, newvalue) {
                if (!ignoreExplicitErrors) {
                    assert.ifError(geterr);
                    assert.deepEqual(newvalue.value, opstate.op_value);
                }

                opstate.op_error = err;
                finishRequest(opstate, qcallback);
            });
    });
}

function finishRequest(opstate, qcallback) {
    var c, errname;

    /*
     * Clear the operation we timeout that we set above.
     */
    clearTimeout(opstate.op_timeout);
    opstate.op_timeout = null;

    /*
     * Categorize the result (success or failure, and if failure, what kind of
     * failure) and maintain counters for each kind of result.
     */
    if (opstate.op_error) {
        errname = opstate.op_error.name;
        for (c = opstate.op_error; c !== null; c = VError.cause(c)) {
            errname += ', ' + c.name;
        }
        if (!nbyerror.hasOwnProperty(errname)) {
            nbyerror[errname] = 0;
        }
        nbyerror[errname]++;
        nfailed++;
    } else {
        nokay++;
    }

    /*
     * Requests do not necessarily complete in order, but this is just a basic
     * progress notification.
     */
    if ((nokay + nfailed) % 1000 === 0) {
        console.log('completed operation %d (%d okay, %d failed so far)',
            nokay + nfailed, nokay, nfailed);
    }

    qcallback();
}

/*
 * Clean up the entire operation.  Remove our test bucket and report what's
 * happened.
 */
function cleanup() {
    console.log('report:');
    console.log('%d operations completed normally', nokay);
    console.log('%d operations failed', nfailed);
    jsprim.forEachKey(nbyerror, function (errname, count) {
        console.log('    %d error: %s', count, errname);
    });

    console.log('deleting test bucket "%s"', bucket);
    client.deleteBucket(bucket, function (err) {
        assert.ifError(err);
        console.log('closing client');
        client.close();
    });
}

main();
