/**
 * Cloudflare Worker — GitHub OAuth Access Gate
 *
 * Handles the OAuth flow, checks for a verified @microsoft.com email,
 * and invites the user as a collaborator to mcaps-csa/CSA.Skills.
 *
 * Environment variables (set as Worker secrets):
 *   GITHUB_CLIENT_ID     — from your GitHub OAuth App
 *   GITHUB_CLIENT_SECRET — from your GitHub OAuth App
 *   GITHUB_PAT           — Personal Access Token with repo scope + admin access to CSA.Skills
 *   PAGES_URL            — your GitHub Pages URL (e.g., https://promney.github.io/repo-access)
 */

const TARGET_OWNER = 'mcaps-csa';
const TARGET_REPO = 'CSA.Skills';
const ALLOWED_DOMAIN = 'microsoft.com';
const INVITE_PERMISSION = 'push'; // pull = read, push = write, admin = admin

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth') {
      return handleAuth(env);
    }
    if (url.pathname === '/callback') {
      return handleCallback(url, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

/**
 * Step 1: Redirect to GitHub OAuth authorization page
 */
function handleAuth(env) {
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${getWorkerUrl(env)}/callback`,
    scope: 'user:email',
    state: state,
  });

  // We pass state in a cookie for CSRF validation
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/**
 * Step 2: Handle the OAuth callback
 */
async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pagesUrl = env.PAGES_URL || 'https://promney.github.io/repo-access';

  if (!code) {
    return redirect(pagesUrl, 'error', 'Authorization was cancelled or failed.');
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'repo-access-worker',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      return redirect(pagesUrl, 'error', `OAuth error: ${tokenData.error_description || tokenData.error}`);
    }

    const userToken = tokenData.access_token;

    // Get the user's profile
    const userRes = await ghApi('https://api.github.com/user', userToken);
    const user = await userRes.json();
    const username = user.login;

    if (!username) {
      return redirect(pagesUrl, 'error', 'Could not determine your GitHub username.');
    }

    // Get the user's verified emails
    const emailsRes = await ghApi('https://api.github.com/user/emails', userToken);
    const emails = await emailsRes.json();

    // Check for a verified @microsoft.com email
    const hasMicrosoftEmail = Array.isArray(emails) && emails.some(
      (e) => e.verified && e.email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)
    );

    if (!hasMicrosoftEmail) {
      return redirect(
        pagesUrl,
        'error',
        `Access denied. No verified @${ALLOWED_DOMAIN} email found on your GitHub account (${username}). ` +
        'Please add and verify your Microsoft email at https://github.com/settings/emails, then try again.'
      );
    }

    // Invite the user as a collaborator
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

    if (inviteRes.status === 201) {
      return redirect(
        pagesUrl,
        'success',
        `✅ Invite sent to ${username}! Check your GitHub notifications or email to accept.`
      );
    } else if (inviteRes.status === 204) {
      return redirect(
        pagesUrl,
        'success',
        `${username} already has access to ${TARGET_OWNER}/${TARGET_REPO}.`
      );
    } else {
      const err = await inviteRes.json().catch(() => ({}));
      return redirect(
        pagesUrl,
        'error',
        `Failed to send invite (HTTP ${inviteRes.status}): ${err.message || 'Unknown error'}`
      );
    }
  } catch (e) {
    return redirect(pagesUrl, 'error', `Unexpected error: ${e.message}`);
  }
}

/** Helper: call GitHub API with a token */
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

/** Helper: redirect back to GitHub Pages with a message */
function redirect(baseUrl, type, message) {
  const url = `${baseUrl}?${type}=${encodeURIComponent(message)}`;
  return new Response(null, { status: 302, headers: { Location: url } });
}

/** Helper: get this worker's own URL (for callback) */
function getWorkerUrl(env) {
  // This is set when deploying. Fallback handled by wrangler.toml `routes`.
  return env.WORKER_URL || 'https://repo-access.YOUR-SUBDOMAIN.workers.dev';
}
