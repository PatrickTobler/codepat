# Local Sokosumi production copy

The Mac Mini refreshes `sokosumi_prod_copy` from the read-only daily review
branch at 04:30 Pacific (11:30 UTC in daylight time, 12:30 UTC otherwise).
The database listens on `127.0.0.1:5432`. Keep the copied data on the Mini.
Use aggregate counts and statuses in review reports.

## Query

```sh
PGSERVICEFILE="$HOME/.config/codepat/prod-copy/pg_service.conf" \
  /opt/homebrew/opt/postgresql@17/bin/psql -Xw 'service=review_reader'
```

The service reads its password from the private `pgpass` file in the same
directory. The reader has SELECT access and defaults to read-only transactions.

## Refresh and check

```sh
~/.local/share/codepat/prod-copy/refresh.sh
~/.local/share/codepat/prod-copy/check.sh
```

The refresh restores into a staging database and switches only after restore
and validation succeed. It skips credentials older than 30 hours. The check
fails if the latest successful refresh exceeds 30 hours or its newest task
exceeds 36 hours. See `~/.local/share/codepat/prod-copy/refresh.log` for outcomes.

## Wipe

Run this on the Mini. Stop the timer and let any active refresh finish before
dropping the databases. This permanently deletes the local copy and refresh log.

```sh
base="$HOME/.local/share/codepat/prod-copy"
agents="$HOME/Library/LaunchAgents"
domain="gui/$(id -u)"
pgbin=/opt/homebrew/opt/postgresql@17/bin

launchctl bootout "$domain/com.codepat.prod-copy-refresh"
"$pgbin/psql" -Xw -h "$base/socket" -U prod_copy_admin -d postgres \
  -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS sokosumi_prod_copy WITH (FORCE)' \
  -c 'DROP DATABASE IF EXISTS sokosumi_prod_copy_next WITH (FORCE)' \
  -c 'DROP DATABASE IF EXISTS sokosumi_prod_copy_old WITH (FORCE)' \
  -c 'DROP DATABASE IF EXISTS prod_copy_meta WITH (FORCE)'
launchctl bootout "$domain/com.codepat.prod-copy-postgres"
rm -i "$agents/com.codepat.prod-copy-refresh.plist" \
  "$agents/com.codepat.prod-copy-postgres.plist"
rm -r "$base" "$HOME/.config/codepat/prod-copy"
```
