# delmany 1 "December 2016" Moray "Moray Client Tools"

## NAME

delmany - delete multiple objects using a filter

## SYNOPSIS

`delmany [COMMON_OPTIONS] [-l LIMIT] [-o OFFSET] BUCKET FILTER`

## DESCRIPTION

Deletes objects from bucket `BUCKET` whose properties match the filter `FILTER`.
Like `findobjects`, `delmany` operations are always bounded in size.  See the
`-l LIMIT` option.  You must use multiple invocations to remove arbitrarily
large lists of objects.

`FILTER` is an LDAP-like filter string described in `findobjects(1)`.  The
caveats described there around the use of unindexed fields apply to filters used
with `delmany` as well.

## OPTIONS

`-l LIMIT`
    Remove at most `LIMIT` objects.  This interacts badly with filters on
    unindexed fields, as described in `findobjects(1)`.  If this option is
    unspecified, a default limit is provided (which is currently 1000).

`-o OFFSET`
    Skip the first `OFFSET` objects matching the filter.
    <!-- XXX is that right? -->

See `moray(1)` for information about the `COMMON_OPTIONS`, which control
the log verbosity and how to locate the remote server.

## ENVIRONMENT

See `moray(1)` for information about the `LOG_LEVEL`, `MORAY_SERVICE`, and
`MORAY_URL` environment variables.

## EXAMPLES

<!-- XXX -->

## SEE ALSO

`moray(1)`, `putbucket(1)`, `putobject(1)`, `findobjects(1)`
