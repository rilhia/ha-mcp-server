# Security

This server can control a Home Assistant instance, so please treat it carefully.

* Run in read only mode unless you need writes.
* Use a dedicated long-lived access token so you can revoke it on its own.
* Never post your token, your Home Assistant address or your audit log in an issue.
* With local models (for example in LM Studio), keep read only mode on and use the never touch list.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's "Report a vulnerability" button on the Security tab of this repository, or contact the maintainer privately.
