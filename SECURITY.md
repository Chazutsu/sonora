# Security Policy

## Supported versions

Only the latest released version receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's **Report a vulnerability** form in the
Security tab of this repository. Include reproduction steps, affected versions,
impact, and a minimal proof of concept when possible.

Please allow up to 7 days for an initial response. We will coordinate disclosure
after a fix is available. Never include private vault content or credentials.

## Security model

Sonora reads only notes explicitly added to its queue. Speech uses the device
synthesis API, and recordings are written directly to the configured vault
folder. The plugin does not transmit note or audio content to an external
service.
