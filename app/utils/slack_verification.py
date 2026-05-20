"""
app/utils/slack_verification.py

Verifies the authenticity of incoming Slack webhook requests using the
X-Slack-Signature header and our app's Signing Secret.

Algorithm (per Slack docs):
  1. Concatenate "v0", the request timestamp, and the raw body:
         sig_basestring = f"v0:{timestamp}:{raw_body}"
  2. HMAC-SHA256-sign sig_basestring using the Signing Secret as the key.
  3. Prefix with "v0=":
         expected = "v0=" + hex_digest
  4. Compare expected with the X-Slack-Signature header using a
     constant-time comparison to prevent timing attacks.

Reference:
  https://docs.slack.dev/authentication/verifying-requests-from-slack
"""

import hashlib
import hmac
import logging
import time

from app.config.settings import get_settings

logger = logging.getLogger(__name__)

# Reject requests whose timestamp is more than 5 minutes old.
# This prevents replay attacks.
_MAX_TIMESTAMP_AGE_SECONDS = 60 * 5


def verify_slack_signature(
    raw_body: bytes,
    timestamp: str,
    signature: str,
) -> bool:
    """
    Returns True if the request is genuinely from Slack, False otherwise.

    Args:
        raw_body  : Raw request body bytes (before any JSON parsing).
        timestamp : Value of the X-Slack-Request-Timestamp header.
        signature : Value of the X-Slack-Signature header  (e.g. "v0=abc123...").

    Security notes:
        - We read the raw bytes BEFORE parsing JSON so the body is unchanged.
        - We use hmac.compare_digest for constant-time comparison.
        - We reject stale timestamps to mitigate replay attacks.
    """
    settings = get_settings()

    # ------------------------------------------------------------------
    # Guard: missing headers
    # ------------------------------------------------------------------
    if not timestamp or not signature:
        logger.warning("Missing X-Slack-Request-Timestamp or X-Slack-Signature header")
        return False

    # ------------------------------------------------------------------
    # Guard: replay attack — reject requests older than 5 minutes
    # ------------------------------------------------------------------
    try:
        request_ts = int(timestamp)
    except ValueError:
        logger.warning("X-Slack-Request-Timestamp is not an integer: %r", timestamp)
        return False

    age = abs(time.time() - request_ts)
    if age > _MAX_TIMESTAMP_AGE_SECONDS:
        logger.warning(
            "Stale Slack request rejected — timestamp age %.0fs exceeds %ds limit",
            age,
            _MAX_TIMESTAMP_AGE_SECONDS,
        )
        return False

    # ------------------------------------------------------------------
    # Compute expected signature
    # ------------------------------------------------------------------
    sig_basestring = f"v0:{timestamp}:{raw_body.decode('utf-8', errors='replace')}"

    expected_signature = (
        "v0="
        + hmac.new(
            key=settings.slack_signing_secret.encode("utf-8"),
            msg=sig_basestring.encode("utf-8"),
            digestmod=hashlib.sha256,
        ).hexdigest()
    )

    # ------------------------------------------------------------------
    # Constant-time comparison
    # ------------------------------------------------------------------
    is_valid = hmac.compare_digest(expected_signature, signature)

    if not is_valid:
        logger.warning(
            "Slack signature mismatch — expected %s..., got %s...",
            expected_signature[:20],
            signature[:20],
        )

    return is_valid