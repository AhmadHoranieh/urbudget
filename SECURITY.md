# Security

Please report security problems privately, not in a public issue: email
**support@urbudget.app** with "Security" in the subject, or use GitHub's private vulnerability
reporting on this repository. Say what you found, how to reproduce it, and what it lets someone do.
You'll get a reply within a few days.

This covers the apps in this repository and the service at urbudget.app: accounts, sign-in, the
sync subscription and encrypted sync storage. Budgets themselves stay on your devices; sync uploads
only data sealed with a key derived from your sync passphrase, which urbudget.app never sees.

Please don't test against other people's accounts or data, or run load tests against urbudget.app.
A local server for testing is described in [web/README.md](web/README.md).
