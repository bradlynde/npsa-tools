"""
Resend (HTTP) notify unit tests — mocked, no real network.
Run: python3 -m unittest tests.test_notify_resend -v
"""

from __future__ import annotations

import base64
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from external_services import notify  # noqa: E402


class TestNotifyResend(unittest.TestCase):
    _env = {
        "NOTIFY_ON_RUN_COMPLETE": "true",
        "RESEND_API_KEY": "re_test_key",
        "NOTIFY_EMAIL": "recipient@test.com",
        "NOTIFY_FROM": "onboarding@resend.dev",
    }

    @patch("external_services.notify.requests.post")
    def test_send_test_notification_posts_resend(self, mock_post: MagicMock) -> None:
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_resp.text = "{}"
        mock_post.return_value = mock_resp
        with patch.dict(os.environ, self._env, clear=False):
            r = notify.send_test_notification_email("School Scraper")
        self.assertEqual(r, {"ok": True})
        mock_post.assert_called_once()

    @patch("external_services.notify.requests.post")
    def test_send_run_complete_posts_resend(self, mock_post: MagicMock) -> None:
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_post.return_value = mock_resp
        with patch.dict(os.environ, self._env, clear=False):
            notify.send_run_complete_email(
                "run-uuid",
                "arkansas",
                10,
                75,
                total_contacts=100,
                total_with_emails=40,
                duration_seconds=120.0,
            )
        body = mock_post.call_args[1]["json"]
        self.assertIn("School Scraper", body["subject"])

    @patch("external_services.notify.requests.post")
    def test_api_error_surfaces_in_test_helper(self, mock_post: MagicMock) -> None:
        mock_resp = MagicMock()
        mock_resp.ok = False
        mock_resp.status_code = 422
        mock_resp.text = "invalid"
        mock_post.return_value = mock_resp
        with patch.dict(os.environ, self._env, clear=False):
            r = notify.send_test_notification_email("School Scraper")
        self.assertFalse(r["ok"])
        self.assertIn("422", r["error"])

    def test_disabled_when_notify_off(self) -> None:
        with patch.dict(os.environ, {"NOTIFY_ON_RUN_COMPLETE": "false"}, clear=False):
            r = notify.send_test_notification_email("School Scraper")
        self.assertFalse(r["ok"])


if __name__ == "__main__":
    unittest.main()


class TestRunCompleteAttachment(unittest.TestCase):
    """The CSV rides along with the notification, unless it can't."""

    _env = {
        "NOTIFY_ON_RUN_COMPLETE": "true",
        "RESEND_API_KEY": "re_test_key",
        "NOTIFY_EMAIL": "recipient@test.com",
        "NOTIFY_FROM": "onboarding@resend.dev",
    }

    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self.csv = os.path.join(self._tmp, "Maryland_leads_abc123.csv")
        with open(self.csv, "w") as fh:
            fh.write("first_name,last_name,email\nA,B,a@b.com\n")

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _send(self, mock_post: MagicMock, **kwargs) -> dict:
        resp = MagicMock()
        resp.ok = True
        mock_post.return_value = resp
        with patch.dict(os.environ, self._env, clear=False):
            notify.send_run_complete_email("abc123", "Maryland", 24, 24, 100, 80, 61.0, **kwargs)
        return mock_post.call_args.kwargs["json"]

    @patch("external_services.notify.requests.post")
    def test_csv_is_attached(self, mock_post: MagicMock) -> None:
        payload = self._send(mock_post, csv_path=self.csv)
        self.assertEqual(len(payload["attachments"]), 1)
        att = payload["attachments"][0]
        self.assertEqual(att["filename"], "Maryland_leads_abc123.csv")
        self.assertEqual(
            base64.b64decode(att["content"]).decode(),
            "first_name,last_name,email\nA,B,a@b.com\n",
        )
        self.assertIn("Attached: Maryland_leads_abc123.csv", payload["html"])

    @patch("external_services.notify.requests.post")
    def test_no_attachment_key_when_no_csv(self, mock_post: MagicMock) -> None:
        payload = self._send(mock_post)
        self.assertNotIn("attachments", payload)

    @patch("external_services.notify.requests.post")
    def test_oversized_csv_still_sends_and_explains(self, mock_post: MagicMock) -> None:
        big = os.path.join(self._tmp, "big.csv")
        with open(big, "wb") as fh:
            fh.write(b"x" * (notify.MAX_ATTACHMENT_BYTES + 1))
        payload = self._send(mock_post, csv_path=big)
        self.assertNotIn("attachments", payload)
        self.assertIn("too large to attach", payload["html"])
        self.assertIn("Scraper tab", payload["html"])
        mock_post.assert_called_once()  # the mail still went

    @patch("external_services.notify.requests.post")
    def test_missing_file_still_sends(self, mock_post: MagicMock) -> None:
        payload = self._send(mock_post, csv_path=os.path.join(self._tmp, "gone.csv"))
        self.assertNotIn("attachments", payload)
        self.assertIn("could not be read", payload["html"])
        mock_post.assert_called_once()

    @patch("external_services.notify.requests.post")
    def test_contacts_found_but_no_path_says_so(self, mock_post: MagicMock) -> None:
        payload = self._send(mock_post)
        self.assertIn("wasn&#x27;t available to attach", payload["html"])


class TestRecipients(unittest.TestCase):
    def test_defaults_when_unset(self) -> None:
        with patch.dict(os.environ, {"NOTIFY_EMAIL": ""}, clear=False):
            self.assertEqual(notify._recipients(), [notify.DEFAULT_NOTIFY_EMAIL])

    def test_env_overrides_default(self) -> None:
        with patch.dict(os.environ, {"NOTIFY_EMAIL": "michael@example.com"}, clear=False):
            self.assertEqual(notify._recipients(), ["michael@example.com"])

    def test_comma_separated_list(self) -> None:
        with patch.dict(os.environ, {"NOTIFY_EMAIL": "a@x.com, b@y.com "}, clear=False):
            self.assertEqual(notify._recipients(), ["a@x.com", "b@y.com"])

    def test_enabled_without_notify_email_because_of_default(self) -> None:
        env = {"RESEND_API_KEY": "re_k", "NOTIFY_EMAIL": "", "NOTIFY_ON_RUN_COMPLETE": "true"}
        with patch.dict(os.environ, env, clear=False):
            self.assertTrue(notify._is_enabled())

    def test_disabled_without_api_key(self) -> None:
        with patch.dict(os.environ, {"RESEND_API_KEY": ""}, clear=False):
            self.assertFalse(notify._is_enabled())
