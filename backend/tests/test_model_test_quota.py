"""Quota-aware model test: 402/insufficient must fail, not tick."""

from llm import _is_key_error


class _FakeExc(Exception):
    def __init__(self, msg, status=None):
        super().__init__(msg)
        self.status_code = status


def test_402_status_is_key_error():
    assert _is_key_error(_FakeExc("Error code: 402 - payment required", status=402)) is True


def test_insufficient_balance_message_is_key_error():
    exc = _FakeExc("Insufficient balance. Please top up your account.")
    assert _is_key_error(exc) is True


def test_insufficient_quota_message_is_key_error():
    exc = _FakeExc("{'error': {'message': 'insufficient_quota', 'code': 402}}")
    assert _is_key_error(exc) is True


def test_context_overflow_is_not_key_error():
    exc = _FakeExc("context length exceeded: insufficient tokens left")
    assert _is_key_error(exc) is False


def test_payment_required_message_is_key_error():
    exc = _FakeExc("payment required: top up your account")
    assert _is_key_error(exc) is True


def test_plain_402_in_body_is_key_error():
    exc = _FakeExc("Error code: 402 - {'error': {'code': 402}}")
    assert _is_key_error(exc) is True
