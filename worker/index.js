/**
 * Cloudflare Worker — GitHub OAuth + Microsoft Entra ID Access Gate
 *
 * Two-step verification:
 *   1. GitHub OAuth — captures the user's GitHub username
 *   2. Microsoft Entra sign-in — proves they are a Microsoft employee
 * If both succeed, the user is auto-invited as a collaborator.
 *
 * Environment variables (set as Worker secrets):
 *   GITHUB_CLIENT_ID      — from your GitHub OAuth App
 *   GITHUB_CLIENT_SECRET  — from your GitHub OAuth App
 *   GITHUB_PAT            — PAT with admin access to the target repo
 *   MS_CLIENT_ID          — from your Entra ID App Registration
 *   MS_CLIENT_SECRET      — from your Entra ID App Registration
 *   MS_TENANT_ID          — Microsoft corporate tenant ID
 *   PAGES_URL             — your GitHub Pages URL
 *   WORKER_URL            — this worker's base URL
 */

const TARGET_OWNER = 'mcaps-csa';
const TARGET_REPO = 'CSA.Skills';
const EXPECTED_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'; // Microsoft corp tenant
const INVITE_PERMISSION = 'push';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/auth':        return handleGitHubAuth(env);
      case '/callback':    return handleGitHubCallback(url, request, env);
      case '/ms-auth':     return handleMsAuth(url, request, env);
      case '/ms-callback': return handleMsCallback(url, request, env);
      default:             return new Response('Not found', { status: 404 });
    }
  },
};

// ─── Step 1: Redirect to GitHub OAuth ─────────────────────────────────────────

function handleGitHubAuth(env) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${workerUrl(env)}/callback`,
    scope: 'user:email',
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      'Set-Cookie': cookie('gh_state', state),
    },
  });
}

// ─── Step 2: GitHub callback — capture username, then redirect to Microsoft ───

async function handleGitHubCallback(url, request, env) {
  const code = url.searchParams.get('code');
  const pagesUrl = env.PAGES_URL || 'https://promney.github.io/repo-access';

  if (!code) {
    return redirect(pagesUrl, 'error', 'GitHub authorization was cancelled or failed.');
  }

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'repo-access-worker' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return redirect(pagesUrl, 'error', `GitHub OAuth error: ${tokenData.error_description || tokenData.error}`);
    }

    // Get GitHub username
    const userRes = await ghApi('https://api.github.com/user', tokenData.access_token);
    const user = await userRes.json();
    if (!user.login) {
      return redirect(pagesUrl, 'error', 'Could not determine your GitHub username.');
    }

    // Store username in a cookie and redirect to Microsoft sign-in
    const msState = crypto.randomUUID();
    const msParams = new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${workerUrl(env)}/ms-callback`,
      scope: 'openid profile email',
      state: msState,
      prompt: 'select_account',
    });

    const tenantId = env.MS_TENANT_ID || EXPECTED_TENANT;

    return new Response(null, {
      status: 302,
      headers: new Headers([
        ['Location', `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${msParams}`],
        ['Set-Cookie', cookie('gh_username', user.login)],
        ['Set-Cookie', cookie('ms_state', msState)],
      ]),
    });
  } catch (e) {
    return redirect(pagesUrl, 'error', `GitHub error: ${e.message}`);
  }
}

// ─── Step 3: Microsoft Entra callback — verify tenant, then invite ────────────

async function handleMsCallback(url, request, env) {
  const code = url.searchParams.get('code');
  const pagesUrl = env.PAGES_URL || 'https://promney.github.io/repo-access';

  // Recover GitHub username from cookie
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const username = cookies['gh_username'];

  if (!code) {
    const errorDesc = url.searchParams.get('error_description') || 'Microsoft sign-in was cancelled or failed.';
    return redirect(pagesUrl, 'error', errorDesc);
  }
  if (!username) {
    return redirect(pagesUrl, 'error', 'Session expired. Please start over.');
  }

  try {
    const tenantId = env.MS_TENANT_ID || EXPECTED_TENANT;

    // Exchange code for token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        code,
        redirect_uri: `${workerUrl(env)}/ms-callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.id_token) {
      return redirect(pagesUrl, 'error', `Microsoft auth error: ${tokenData.error_description || tokenData.error}`);
    }

    // Decode the ID token (JWT) to verify the tenant
    const claims = decodeJwt(tokenData.id_token);
    if (!claims) {
      return redirect(pagesUrl, 'error', 'Could not verify Microsoft identity.');
    }

    if (claims.tid !== EXPECTED_TENANT) {
      return redirect(pagesUrl, 'error', 'Access denied. You must sign in with a Microsoft corporate account.');
    }

    // Verified! Invite the GitHub user as a collaborator
    const inviteRes = await fetch(
      `https://api.github.com/repos/${TARGET_OWNER}/${TARGET_REPO}/collaborators/${username}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'repo-access-worker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ permission: INVITE_PERMISSION }),
      }
    );

    const msName = claims.name || claims.preferred_username || 'Microsoft user';

    if (inviteRes.status === 201) {
      return redirect(pagesUrl, 'success',
        `✅ Verified as ${msName}. Invite sent to GitHub user "${username}"! Check your GitHub notifications to accept.`);
    } else if (inviteRes.status === 204) {
      return redirect(pagesUrl, 'success',
        `${username} already has access to ${TARGET_OWNER}/${TARGET_REPO}.`);
    } else {
      const err = await inviteRes.json().catch(() => ({}));
      return redirect(pagesUrl, 'error',
        `Verified as ${msName}, but invite failed (HTTP ${inviteRes.status}): ${err.message || 'Unknown error'}`);
    }
  } catch (e) {
    return redirect(pagesUrl, 'error', `Microsoft verification error: ${e.message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ghApi(url, token) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'repo-access-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

function redirect(baseUrl, type, message) {
  const url = `${baseUrl}?${type}=${encodeURIComponent(message)}`;
  return new Response(null, { status: 302, headers: { Location: url } });
}

function workerUrl(env) {
  return env.WORKER_URL || 'https://repo-access.promney.workers.dev';
}

function cookie(name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

/** Decode a JWT payload without verification (tenant check is sufficient) */
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}
