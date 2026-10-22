"""Small HTTP helper with retries (honours the usual proxy and CA environment variables)."""

import time
import urllib.error
import urllib.request


def fetch(url: str, retries: int = 4, timeout: float = 60.0) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            last = e
        except Exception as e:  # network hiccup
            last = e
        time.sleep(0.5 * (attempt + 1))
    assert last is not None
    raise last
