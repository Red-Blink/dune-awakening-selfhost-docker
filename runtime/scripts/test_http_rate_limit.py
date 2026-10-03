import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("http_rate_limit", Path(__file__).with_name("http-rate-limit.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)


class RateLimitTest(unittest.TestCase):
    def check(self, headers, body=""):
        return module.summarize(headers, body, NOW)

    def test_primary_limit(self):
        result = self.check("HTTP/2 403\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 1790943000\n")
        self.assertEqual(result, "GitHub request limit reached. Try again after 2026-10-02 12:10:00 UTC.")

    def test_retry_after_seconds(self):
        self.assertIn("12:10:00 UTC", self.check("HTTP/2 429\nRetry-After: 600\n"))

    def test_retry_after_date(self):
        self.assertIn("12:10:00 UTC", self.check("HTTP/2 429\nRetry-After: Fri, 02 Oct 2026 12:10:00 GMT\n"))

    def test_secondary_does_not_use_primary_reset(self):
        result = self.check("HTTP/2 403\nx-ratelimit-reset: 1790943000\n", '{"message":"You have exceeded a secondary rate limit."}')
        self.assertIn("no retry time was provided", result)

    def test_forbidden_and_unauthorized_are_not_limits(self):
        for status in (401, 403, 503):
            self.assertEqual(self.check(f"HTTP/2 {status}\n", '{"message":"Bad credentials"}'), "")

    def test_successful_retry_clears_previous_limit(self):
        self.assertEqual(self.check("HTTP/2 429\nRetry-After: 600\n\nHTTP/2 200\n"), "")

    def test_missing_and_bad_cooldowns(self):
        for value in ("", "nope", "9" * 100, "Wed, nope"):
            self.assertIn("no retry time was provided", self.check(f"HTTP/2 429\nRetry-After: {value}\n"))

    def test_response_body_is_never_echoed(self):
        result = self.check("HTTP/2 403\n", '{"message":"API rate limit exceeded for private-address", "secret":"private-token"}')
        self.assertNotIn("private", result)

    def test_past_reset(self):
        self.assertIn("try again now", self.check("HTTP/2 403\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 1\n"))


if __name__ == "__main__":
    unittest.main()
