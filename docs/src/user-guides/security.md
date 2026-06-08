# Security of your Apple ID credentials

Since this application needs to communicate with the Apple iCloud backend, full access to your AppleID needs to be provided. By open-sourcing this application, I hope to gain your trust, that I am not able to read or access your credentials or tokens!

This application will never log any credentials. Credentials are only sent directly to Apple's authentication servers - third party services are NOT involved in this process.

Apple ID credentials entered through the Web UI are kept in memory only. They are not written to the `.icloud-photos-sync` resource file, logs, metrics, or any other local file, and they must be entered again after every service restart. If `APPLE_ID_USER` and `APPLE_ID_PWD` are supplied through the environment, those startup credentials take precedence over Web UI credentials.

In order to improve this application's development, this tool can report crash and error data to the developer. This capability requires opt-in and is the only non-Apple service this application will communicate with. Scrubbing of credentials and sensitive data is performed before any errors are reported. More information about this topic can be found [here](error-reporting.md).
