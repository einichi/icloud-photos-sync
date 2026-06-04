# Notifications

`icloud-photos-sync` supports two notification mechanisms:

- Browser push notifications from the Web UI.
- Optional SMTP email notifications configured through environment variables or matching CLI options.

SMTP notifications are disabled unless the minimum SMTP settings are present. SMTP credentials are only read from process configuration and are not written to the `.icloud-photos-sync` resource file.

## SMTP Email Notifications

SMTP email notifications are sent for these events:

- The container starts without Apple ID credentials in memory, so the user needs to authenticate through the Web UI.
- The stored iCloud trust token is nearing expiry. Warnings are sent at most once per day while the token is inside the configured warning window.

The trust token expiry is estimated from the `trustTokenCreatedAt` timestamp in the `.icloud-photos-sync` resource file plus `TRUST_TOKEN_LIFETIME_DAYS`. The timestamp is created when a new token is stored; existing resource files that already have a token but no timestamp will get one automatically.

### Environment Variables

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `SMTP_HOST` | unset | yes | SMTP server hostname. Email notifications are disabled when this is unset. |
| `SMTP_PORT` | `587` | yes | SMTP server port. Use `587` with `SMTP_SECURE=starttls` or `465` with `SMTP_SECURE=implicit`. |
| `SMTP_SECURE` | `starttls` | no | TLS mode. `starttls` connects plain, requires the server to advertise STARTTLS, then upgrades before authentication/mail. `implicit` opens the connection with TLS immediately. |
| `SMTP_USER` | unset | no | SMTP username. If both `SMTP_USER` and `SMTP_PASSWORD` are set, `AUTH PLAIN` is used. |
| `SMTP_PASSWORD` | unset | no | SMTP password. Keep this in environment/secrets management; it is not persisted by ICPS. |
| `SMTP_FROM` | unset | yes | Sender address, for example `iCloud Photos Sync <photos-sync@example.com>`. |
| `SMTP_TO` | unset | yes | Recipient address. Multiple recipients can be comma-separated. |
| `SMTP_TOKEN_EXPIRY_WARNING_DAYS` | `3` | no | Start sending daily trust-token expiry warning emails this many days before estimated expiry. |
| `TRUST_TOKEN_LIFETIME_DAYS` | `60` | no | Number of days a stored trust token is considered valid for Web UI display and notification scheduling. |

### Docker Compose Example

```yaml
services:
  photos-sync:
    image: steilerdev/icloud-photos-sync:latest
    container_name: photos-sync
    environment:
      SMTP_HOST: "smtp.example.com"
      SMTP_PORT: 587
      SMTP_SECURE: "starttls"
      SMTP_USER: "photos-sync@example.com"
      SMTP_PASSWORD: "<smtp-password>"
      SMTP_FROM: "iCloud Photos Sync <photos-sync@example.com>"
      SMTP_TO: "you@example.com"
      SMTP_TOKEN_EXPIRY_WARNING_DAYS: 3
      TRUST_TOKEN_LIFETIME_DAYS: 60
```

!!! note "Startup authentication reminders"
    The startup email is sent when SMTP is configured and the service starts without Apple ID credentials supplied through `APPLE_ID_USER` and `APPLE_ID_PWD`. Credentials entered in the Web UI are held in memory only, so this reminder is useful after container restarts.
