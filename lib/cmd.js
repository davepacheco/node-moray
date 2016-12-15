/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/cmd.js: common functions used by command-line utilities
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var getopt = require('posix-getopt');
var net = require('net');
var path = require('path');
var url = require('url');

exports.parseCliOptions = parseCliOptions;
exports.parseTcpPort = parseTcpPort;
exports.commonUsage = '[-h host] [-p port] [-S service] [-v]';

var commonOptStr = 'h:(host)p:(port)S:(service)v';

/*
 * Parses command-line options.
 */
function parseCliOptions(args) {
    var parser, option;

    assert.object(args, 'args');
    assert.object(args.argv, 'args.argv');
    assert.object(args.env, 'args.env');
    assert.string(args.extraOptStr, 'args.extraOptStr');
    assert.object(args.clientOptions, 'args.clientOptions');
    assert.func(args.onUsage, 'args.onUsage');
    assert.func(args.onOption, 'args.onOption');

    if (!args.clientOptions.log) {
        args.clientOptions.log = bunyan.createLogger({
            'name': path.basename(args.argv[1]),
            'level': (args.env.LOG_LEVEL || 'fatal'),
            'stream': process.stderr,
            'serializers': bunyan.stdSerializers
        });
    }

    /* XXX validate extraOptStr doesn't try to override our options */
    parser = new getopt.BasicParser(commonOptStr + args.extraOptStr, args.argv);
    while ((option = parser.getopt()) !== undefined) {
        switch (option.option) {
        case 'h':
        case 'p':
        case 'S':
        case 'v':
            if (!parseCommonCliOption(args.clientOptions, option)) {
                args.onUsage();
            }
            break;

        default:
            args.onOption(option);
            break;
        }
    }

    args.clientOptions.failFast = true;
    args.clientOptions.mustCloseBeforeNormalProcessExit = true;
    if (!finalizeCliOptions(args.clientOptions, args.env)) {
        args.onUsage();
    }

    return (parser);
}

/*
 * Parses one of the command-line options that's common to several commands.
 * This currently includes:
 *
 *   -h / --host HOSTNAME
 *   -p / --port PORT
 *   -S / --service SERVICE
 *
 * "options" is an object in which we're building the Moray client
 * configuration.  "option" is a node-getopt option object.
 *
 * If there is an error, prints an error message and returns false.
 */
function parseCommonCliOption(options, option) {
    var p, log;

    assert.object(options, 'options');
    assert.object(option, 'option');

    switch (option.option) {
    case 'h':
        options.host = option.optarg;
        break;

    case 'p':
        p = parseTcpPort(option.optarg);
        if (p === null) {
            console.error('-p/--port: expected valid TCP port');
            return (false);
        }
        options.port = p;
        break;

    case 'S':
        if (!validateSrvDomain(option.optarg)) {
            return (false);
        }

        options.srvDomain = option.optarg;
        break;

    case 'v':
        /*
         * This allows "-v" to be used multiple times and ensures that we
         * never wind up at a level less than TRACE.
         */
        log = options.log;
        log.level(Math.max(bunyan.TRACE, (log.level() - 10)));
        if (log.level() <= bunyan.DEBUG)
            log = log.child({src: true});
        break;

    default:
        throw (new Error('tried to parse non-common option'));
    }

    return (true);
}

/*
 * Performs final validation on CLI options and populates required arguments
 * with default values.  Like parseCommonCliOption(), on error this prints an
 * error message to stderr and returns false.
 */
function finalizeCliOptions(options, env) {
    if (options.srvDomain !== undefined) {
        /* The user specified -s/--service. */
        if (options.port !== undefined || options.host !== undefined) {
            console.error('-S/--service cannot be combined with -h/--host ' +
                'or -p/--port');
            return (false);
        }

        return (true);
    }

    if (options.host !== undefined && options.port !== undefined) {
        /* The user specified both -h/--host and -p/--port. */
        return (true);
    }

    if (options.host !== undefined || options.port !== undefined) {
        return (populateDirectArguments(options, env));
    }

    /*
     * The user specified nothing on the command line.  Check for MORAY_SERVICE.
     */
    if (env['MORAY_SERVICE']) {
        if (!validateSrvDomain(env['MORAY_SERVICE'])) {
            return (false);
        }

        options.srvDomain = env['MORAY_SERVICE'];
        return (true);
    }

    return (populateDirectArguments(options, env));
}

function validateSrvDomain(domain) {
    if (net.isIP(domain)) {
        console.error(
            'cannot use an IP address with -S/--service/MORAY_SERVICE');
        return (false);
    }

    return (true);
}

/*
 * Given a set of Moray client arguments, ensure that "host" and "port" are
 * populated based on MORAY_URL or our default values.  Like the other functions
 * in this file, on error, prints an error message and then returns "false" on
 * failure.
 *
 * Importantly, don't parse MORAY_URL if we're not going to use it.
 */
function populateDirectArguments(options, env) {
    var u, p;

    if (options.host === undefined || options.port === undefined) {
        /*
         * The user specified one of -h/--host and -p/--port, but not the other.
         */
        if (env['MORAY_URL']) {
            u = url.parse(env['MORAY_URL']);
            if (options.host === undefined) {
                options.host = u['hostname'];
            }

            if (options.port === undefined && u['port'] !== null) {
                p = parseTcpPort(u['port']);
                if (p === null) {
                    console.error('port in MORAY_URL is not a valid TCP port');
                    return (false);
                }

                options.port = p;
            }
        }

        if (options.host === undefined) {
            options.host = '127.0.0.1';
        }

        if (options.port === undefined) {
            options.port = 2020;
        }
    }

    return (true);
}

function parseTcpPort(portstr) {
    var p;

    assert.string(portstr, 'portstr');
    p = parseInt(portstr, 10);
    if (isNaN(p) || p < 0 || p >= 65536) {
        return (null);
    }

    return (p);
}
