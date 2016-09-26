/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/fast_connection.js: implementation of the Cueball's "Connection"
 * interface backed by a Fast client.
 */

var assert = require('assert-plus');
var events = require('events');
var fast = require('fast');
var net = require('net');
var util = require('util');
var VError = require('verror');

module.exports = FastConnection;

/*
 * Named arguments:
 *
 *     address                  IPv4 or IPv6 address, interpreted by
 *     (string)                 net.createConnection().
 *
 *     port                     TCP port, used for net.createConnection().
 *     (number)
 *
 *     log                      bunyan-style logger
 *     (object)
 *
 *     nRecentRequests          see FastClient constructor
 *     (number)
 *
 *     tcpKeepAliveInitialDelay initial TCP keep-alive delay (in milliseconds)
 *     (number)
 */
function FastConnection(args)
{
    assert.object(args, 'args');
    assert.string(args.address, 'args.address');
    assert.number(args.port, 'args.port');
    assert.object(args.log, 'args.log');
    assert.number(args.nRecentRequests, 'args.nRecentRequests');
    assert.number(args.tcpKeepAliveInitialDelay,
        'args.tcpKeepAliveInitialDelay');

    events.EventEmitter.call(this);

    this.fc_address = args.address;
    this.fc_port = args.port;
    this.fc_tcpka_delay = args.tcpKeepAliveInitialDelay;

    this.fc_all_errors = [];

    this.fc_sock = net.createConnection(args.port, args.address);
    this.fc_destroyed = false;
    this.fc_fast = new fast.FastClient({
        'nRecentRequests': args.nRecentRequests,
        'transport': this.fc_sock,
        'log': args.log
    });

    this.fc_sock.on('close', this.emit.bind(this, 'close'));
    this.fc_sock.on('connect', this.onSocketConnect.bind(this));
    this.fc_sock.on('error', this.onSocketError.bind(this));
    this.fc_fast.on('error', this.onFastError.bind(this));
}

util.inherits(FastConnection, events.EventEmitter);

/* [private] */
FastConnection.prototype.onSocketConnect = function onSocketConnect()
{
    /*
     * It's important to enable TCP KeepAlive on connections to the Moray server
     * so that we can identify connections that have failed as a result of a
     * remote system panic, power cycle, power off, or a network partition.
     * This will not address requests that have hung as a result of a server
     * problem; callers are expected to deal with that on their own.  This
     * client can't necessarily know what timeouts are reasonable, nor the scope
     * of such a problem, nor how to deal with a request that's taking too long.
     *
     * Node provides an API for enabling TCP KeepAlive and setting the initial
     * interval, but it has two major issues: first, on at least Node v0.10 and
     * likely v0.12, it only works once the socket has been connected.  Before
     * that, the request to enable KeepAlive is silently ignored.  For details,
     * see nodejs/node-v0.x-archive issue 8572.  That's why we don't call
     * setKeepAlive() until we get here.
     *
     * Second, the interface only allows us to configure the initial interval of
     * idle time before TCP starts sending KeepAlive probes (equivalent to
     * TCP_KEEPIDLE), not how long to keep sending probes before terminating the
     * connection (TCP_KEEPCNT and TCP_KEEPINTVL or
     * TCP_KEEPALIVE_ABORT_THRESHOLD).  Since Moray is only used inside
     * environments expected to have good network connectivity, an aggressive
     * configuration would be appropriate here, but for now we're left with the
     * system defaults (which are pretty conservative).  We'll eventually learn
     * if this connection fails, but not all that quickly.
     */
    this.fc_sock.setKeepAlive(true, this.fc_tcpka_delay);

    /* Cueball requires that we pass this event through. */
    this.emit('connect');
};

/* [private] */
FastConnection.prototype.onSocketError = function onSocketError(err)
{
    assert.ok(err instanceof Error);
    this.onError(new VError({
        'cause': err,
        'info': {
            'ipAddr': this.fc_address,
            'tcpPort': this.fc_port
        }
    }, 'socket to %s:%d', this.fc_address, this.fc_port));
};

/* [private] */
FastConnection.prototype.onFastError = function onFastError(err)
{
    assert.ok(err instanceof Error);
    this.onError(new VError({
        'cause': err,
        'info': {
            'ipAddr': this.fc_address,
            'tcpPort': this.fc_port
        }
    }, 'fast client for %s:%d', this.fc_address, this.fc_port));
};

/* [private] */
FastConnection.prototype.onError = function onError(err)
{
    assert.ok(err instanceof Error);

    /*
     * It's possible for either or both of the socket and the Fast client to
     * emit an error.  We only pass through the first one, but we record all of
     * them for debugging.
     * XXX-cueball: is it expected that we'll suppress errors after destroy()?
     * It seems that cueball doesn't handle errors from the "closed" state, nor
     * does it wait for "error" before reaching that state.
     */
    this.fc_all_errors.push(err);
    if (!this.fc_destroyed && this.fc_all_errors.length == 1) {
        this.emit('error', err);
    }
};

/*
 * Used by the rest of the Moray client
 */
FastConnection.prototype.fastClient = function ()
{
    return (this.fc_fast);
};

/*
 * Implementation of the Cueball "Connection" interface
 */

FastConnection.prototype.destroy = function ()
{
    this.fc_destroyed = true;
    this.fc_sock.destroy();
};

/*
 * Cueball requires that we implement ref() and unref(), but they don't need to
 * do anything.  These interfaces are usually used to allow callers to avoid
 * having to explicit close client connections or connection pools (allowing a
 * Node program to exit if that's all that's left).  We don't allow that here.
 */
FastConnection.prototype.ref = function ref() {};
FastConnection.prototype.unref = function unref() {};