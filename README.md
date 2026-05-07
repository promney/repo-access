# repo-access

Automated access request system for `mcaps-csa/CSA.Skills`.

## How it works

1. User visits the GitHub Pages site and clicks "Sign in with GitHub"
2. GitHub OAuth flow authenticates the user and grants `user:email` scope
3. A Cloudflare Worker checks for a **verified `@microsoft.com` email**
4. If verified, the worker auto-invites the user as a collaborator
5. User accepts the invite from their GitHub notifications

## Setup

See [SETUP.md](SETUP.md) for full deployment instructions.
