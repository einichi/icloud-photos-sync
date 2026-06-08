# WebUI

Since this tool is syncing all assets to the native file system, pretty much any tool can be used to present the pictures. I've been testing some tools recommended by [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted#photo-and-video-galleries) and settled on [Photoview](https://photoview.github.io/). The following `docker-compose.yml` will run `icloud-photos-sync` together with `Photoview`:

```
services:
  photos-sync:
    image: steilerdev/icloud-photos-sync:latest
    container_name: photos-sync
    user: <uid>:<gid> 
    environment:
      TZ: "Europe/Berlin"                                                       
      SCHEDULE: "* 2 * * *"
      SCHEDULED_CHECKSUM_VERIFICATION: true
      SCHEDULED_CHECKSUM_VERIFICATION_DAYS: "0,1,2,3,4,5,6"
      ENABLE_CRASH_REPORTING: true
    volumes:
      - <photos-dir>:/opt/icloud-photos-library
  photoview-db:
    image: mariadb:10.5
    container_name: photos-photoview-db
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: "photoview"
      MYSQL_USER: "photoview"
      MYSQL_PASSWORD: "<some-password>"
      MYSQL_RANDOM_ROOT_PASSWORD: 1
    volumes:
      - db:/var/lib/mysql
  photoview:
    image: viktorstrate/photoview:2
    container_name: photos-photoview
    restart: unless-stopped
    depends_on:
      - photoview-db
    environment:
      PHOTOVIEW_MYSQL_URL: photoview:<some-password>@tcp(photoview-db)/photoview
      PHOTOVIEW_LISTEN_IP: 0.0.0.0
      PHOTOVIEW_LISTEN_PORT: 80
      PHOTOVIEW_MEDIA_CACHE: /app/cache
    ports:
      - "80:80"
    volumes:
      - <photos-dir>:/photos:ro
      - cache:/app/cache
volumes:
    db:
    cache:
```

Apple ID credentials can be entered from the `icloud-photos-sync` Web UI after startup. They are kept in memory only and must be entered again after every service restart. If you prefer unattended startup, set `APPLE_ID_USER` and `APPLE_ID_PWD` in the environment; those startup credentials take precedence over Web UI credentials.

When an MFA token is available, the ready page shows an estimated expiry countdown below the status text. This estimate is based on the `trustTokenCreatedAt` timestamp in the `.icloud-photos-sync` resource file and the configured `TRUST_TOKEN_LIFETIME_DAYS` value. The token itself is still the source of authentication; the timestamp is only used for display and optional notification scheduling.

Optional SMTP notifications can also be enabled to email you when the service starts without in-memory credentials and when the MFA token is nearing expiry. See [Notifications](notifications.md).

Scheduled syncs verify checksums for kept local assets by default. Set `SCHEDULED_CHECKSUM_VERIFICATION` to `false` to skip that verification for scheduled syncs only. To run verification only on selected scheduled-run weekdays, set `SCHEDULED_CHECKSUM_VERIFICATION_DAYS` to comma-separated numbers from `0` through `6`, where `0` is Sunday and `6` is Saturday. Web UI-triggered syncs and one-off CLI syncs always verify checksums.

While a sync is running, the Web UI progress bar reflects overall sync progress while advancing inside the current phase. Remote metadata fetches, local checksum verification, and asset downloads also show detail below the main status text, including the currently downloading filename when available.
