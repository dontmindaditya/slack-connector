"""
app/utils/retry.py

Retry wrapper for Slack Web API calls with exponential backoff and
automatic handling of Slack's 429 Too Many Requests responses.

Slack rate-limit behaviour:
  - Returns HTTP 429 with a Retry-After header (seconds to wait).
  - Applies per-method, per-workspace, per-app.
  - Tiers range from 1 req/min (Tier 1) to 100+ req/min (Tier 4).

Usage:
    from app.utils.retry import with_slack_retry

    response = await with_slack_retry(client.conversations_history, channel="C123")

The wrapper is intentionally thin — it only handles rate limits and
transient network errors.  Business logic errors (not_in_channel,
channel_not_found, etc.) bubble up immediately as SlackApiError.
"""

import asyncio
import logging
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

from slack_sdk.errors import SlackApiError

from app.config.settings import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

T = TypeVar("T")


async def with_slack_retry(
    api_call: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    max_retries: int | None = None,
    base_delay: float | None = None,
    **kwargs: Any,
) -> T:
    """
    Call an async Slack SDK method with automatic retry on rate limits.

    Args:
        api_call    : The async SDK method to call, e.g. client.conversations_history
        *args       : Positional arguments forwarded to api_call
        max_retries : Override settings.slack_max_retries for this specific call
        base_delay  : Override settings.slack_retry_delay (seconds, exponential base)
        **kwargs    : Keyword arguments forwarded to api_call

    Returns:
        The SlackResponse from the API call.

    Raises:
        SlackApiError    : On non-rate-limit errors, or after all retries exhausted.
        asyncio.TimeoutError : If the call itself times out (not handled here).

    Retry strategy:
        Attempt 1 → immediate
        Attempt 2 → wait Retry-After (from header) OR base_delay * 2^0
        Attempt 3 → wait Retry-After OR base_delay * 2^1
        ...
        After max_retries: re-raise the last SlackApiError
    """
    _max_retries = max_retries if max_retries is not None else settings.slack_max_retries
    _base_delay = base_delay if base_delay is not None else settings.slack_retry_delay

    last_error: SlackApiError | None = None

    for attempt in range(_max_retries + 1):   # attempt 0 is the first try
        try:
            return await api_call(*args, **kwargs)

        except SlackApiError as exc:
            error_code = exc.response.get("error", "unknown") if exc.response else "unknown"

            # ----------------------------------------------------------
            # Non-rate-limit errors should NOT be retried
            # ----------------------------------------------------------
            if error_code != "ratelimited":
                logger.debug(
                    "Slack API error (not retryable): %s on attempt %d",
                    error_code,
                    attempt + 1,
                )
                raise

            # ----------------------------------------------------------
            # 429 / ratelimited — respect Retry-After if present
            # ----------------------------------------------------------
            last_error = exc

            # Slack sets Retry-After on the response headers (seconds as int/str)
            retry_after_raw = (
                exc.response.headers.get("Retry-After")
                if hasattr(exc.response, "headers") and exc.response.headers
                else None
            )

            try:
                retry_after = float(retry_after_raw) if retry_after_raw else None
            except (TypeError, ValueError):
                retry_after = None

            # Fallback: exponential backoff from base_delay
            backoff_delay = _base_delay * (2 ** attempt)
            wait_seconds = retry_after if retry_after is not None else backoff_delay

            if attempt < _max_retries:
                logger.warning(
                    "Slack rate limit hit (%s) — waiting %.1fs before retry %d/%d",
                    api_call.__name__ if hasattr(api_call, "__name__") else str(api_call),
                    wait_seconds,
                    attempt + 1,
                    _max_retries,
                )
                await asyncio.sleep(wait_seconds)
            else:
                logger.error(
                    "Slack rate limit: exhausted %d retries for %s",
                    _max_retries,
                    api_call.__name__ if hasattr(api_call, "__name__") else str(api_call),
                )

        except (ConnectionError, TimeoutError, OSError) as exc:
            # Transient network errors — retry with backoff
            last_error_net = exc
            if attempt < _max_retries:
                wait_seconds = _base_delay * (2 ** attempt)
                logger.warning(
                    "Network error on attempt %d/%d — retrying in %.1fs: %s",
                    attempt + 1,
                    _max_retries + 1,
                    wait_seconds,
                    exc,
                )
                await asyncio.sleep(wait_seconds)
            else:
                logger.error("Network error after %d retries: %s", _max_retries, exc)
                raise

    # Should only reach here after exhausting retries on a rate-limit error
    if last_error:
        raise last_error

    # Unreachable but satisfies the type checker
    raise RuntimeError("with_slack_retry: unexpected exit from retry loop")


# ---------------------------------------------------------------------------
# Context manager variant (for sequential batches)
# ---------------------------------------------------------------------------

class SlackRateLimitBudget:
    """
    Simple token-bucket helper for tight loops that call Slack in sequence.

    Usage:
        budget = SlackRateLimitBudget(calls_per_second=0.9)
        for channel_id in channels:
            await budget.acquire()
            await with_slack_retry(client.conversations_info, channel=channel_id)

    Set calls_per_second=0.9 to stay safely below the Tier 1 (1 req/min)
    limit when calling many low-tier methods in a loop.
    """

    def __init__(self, calls_per_second: float = 1.0) -> None:
        self._min_interval = 1.0 / calls_per_second
        self._last_call: float = 0.0

    async def acquire(self) -> None:
        """Sleep if needed to honour the configured rate."""
        now = asyncio.get_event_loop().time()
        elapsed = now - self._last_call
        if elapsed < self._min_interval:
            await asyncio.sleep(self._min_interval - elapsed)
        self._last_call = asyncio.get_event_loop().time()