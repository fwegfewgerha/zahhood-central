// Landing page: explain why a sign-in was turned away.
// Lives in its own file because the Content-Security-Policy is `script-src
// 'self'` - inline scripts are blocked on purpose.

const MESSAGES = {
  discord_not_configured:
    'Discord login is not set up on this server yet. The owner needs to fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.',
  not_in_server: 'You are not a member of the Zah Hood Discord server, so you cannot sign in here.',
  not_whitelisted:
    'Your Discord account is not on the whitelist for this site. Ask an owner to add your Discord user ID. If you are trying to appeal a ban, use the Appeal a ban button instead.',
  too_many_attempts: 'Too many failed sign-in attempts from your connection. Wait 15 minutes and try again.',
  discord_rate_limited:
    'Discord is temporarily rate-limiting this app and will not issue a login token. Nothing is wrong with your account - wait a few minutes and try again.',
  code_already_used: 'That login link was already used. Start the sign-in again from this page rather than refreshing.',
  account_suspended: 'This account has been suspended from the panel.',
  bad_state: 'That login attempt expired or was tampered with. Try again.',
  missing_code: 'Discord did not send a login code back. Try again.',
  oauth_failed: 'Discord rejected the login. Try again in a moment.',
  guild_check_failed: 'Could not confirm your Discord server membership. Try again.',
  access_denied: 'You cancelled the Discord login.',
};

const params = new URLSearchParams(location.search);
const err = params.get('error');

if (err) {
  const slot = document.getElementById('error-slot');
  const div = document.createElement('div');
  div.className = 'alert';

  let text = MESSAGES[err] || `Login failed: ${err}`;
  const detail = params.get('detail');
  if (err === 'discord_rate_limited' && detail && Number(detail) > 0) {
    text += ` Discord suggests waiting about ${detail} seconds.`;
  }
  div.textContent = text;
  slot.appendChild(div);
}
