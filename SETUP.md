# Setup Guide

## Prerequisites
- GitHub account with admin access to `mcaps-csa/CSA.Skills`
- Cloudflare account (free tier — sign up at https://dash.cloudflare.com)
- Node.js installed (for Wrangler CLI)

---

## Step 1: Create a GitHub Personal Access Token (PAT)

1. Go to https://github.com/settings/tokens?type=beta (Fine-grained tokens)
2. Click **Generate new token**
3. Name: `repo-access-worker`
4. Resource owner: select **mcaps-csa** (the org)
5. Repository access: **Only select repositories** → select `CSA.Skills`
6. Permissions:
   - Repository permissions → **Administration** → **Read and write**
7. Click **Generate token** and copy it — you'll need it in Step 4

> If fine-grained tokens aren't available for the org, use a classic PAT
> with `repo` scope instead (https://github.com/settings/tokens).

---

## Step 2: Create a GitHub OAuth App

1. Go to https://github.com/settings/developers
2. Click **OAuth Apps** → **New OAuth App**
3. Fill in:
   - **Application name:** `CSA.Skills Access Request`
   - **Homepage URL:** `https://promney.github.io/repo-access`
   - **Authorization callback URL:** `https://repo-access.YOUR-SUBDOMAIN.workers.dev/callback`
     _(you'll get the exact URL after deploying the worker in Step 3 — you can update this later)_
4. Click **Register application**
5. Copy the **Client ID**
6. Click **Generate a new client secret** and copy it

---

## Step 3: Deploy the Cloudflare Worker

### 3a. Sign up for Cloudflare
Go to https://dash.cloudflare.com and create a free account.

### 3b. Install Wrangler & deploy
```bash
cd worker
npm install -g wrangler
wrangler login          # opens browser to authenticate
wrangler deploy         # deploys the worker
```

After deploy, Wrangler will print your worker URL like:
```
https://repo-access.YOUR-SUBDOMAIN.workers.dev
```

### 3c. Set secrets
```bash
npx wrangler secret put GITHUB_CLIENT_ID
# paste your OAuth App Client ID

npx wrangler secret put GITHUB_CLIENT_SECRET
# paste your OAuth App Client Secret

npx wrangler secret put GITHUB_PAT
# paste your Personal Access Token from Step 1

npx wrangler secret put PAGES_URL
# enter: https://promney.github.io/repo-access

npx wrangler secret put WORKER_URL
# enter: https://repo-access.YOUR-SUBDOMAIN.workers.dev
```

### 3d. Update the OAuth App callback URL
Go back to your OAuth App settings and update the **Authorization callback URL** to:
```
https://repo-access.YOUR-SUBDOMAIN.workers.dev/callback
```

---

## Step 4: Push the GitHub Pages repo

The repo has already been created at `promney/repo-access`.
GitHub Pages serves from the `docs/` folder on the `main` branch.

After pushing, enable Pages:
1. Go to https://github.com/promney/repo-access/settings/pages
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/docs`
4. Save

---

## Step 5: Update the landing page

Edit `docs/index.html` and replace `REPLACE_WORKER_URL` with your actual worker URL:
```
https://repo-access.YOUR-SUBDOMAIN.workers.dev
```

Push the change.

---

## Step 6: Test

1. Open https://promney.github.io/repo-access in an incognito window
2. Click "Sign in with GitHub"
3. Authorize the OAuth App
4. If your GitHub account has a verified @microsoft.com email → you should see a success message
5. Check https://github.com/mcaps-csa/CSA.Skills/invitations for the invite

---

## Notes on invite acceptance

GitHub requires users to **accept** the collaborator invite. This cannot be automated on their behalf.
The landing page includes links to notifications and the pending invitations page.
Users will also receive an email notification from GitHub.
