"""Graph assembly: the Coder runs the project's tests itself (via run_terminal),
so the graph must NOT contain an automatic test/debug loop.

Verifies that ``build_graph`` compiles without a ``test`` or ``debug`` node and
that the Coder tail routes straight to ``review`` -> ``done``.
"""

import graph as G


def _graph_nodes_edges():
    """Return (set_of_node_ids, list_of_(source, target)) for the compiled graph."""
    compiled = G.build_graph()
    g = compiled.get_graph()
    # LangGraph's get_graph() returns `nodes` as a dict keyed by node id and
    # `edges` as a list of (source, target) tuples in this version.
    nodes = set(g.nodes.keys())
    edges = [(e[0], e[1]) for e in g.edges]
    return nodes, edges


def test_no_test_or_debug_nodes():
    nodes, _ = _graph_nodes_edges()
    assert "test" not in nodes
    assert "debug" not in nodes


def test_coder_routes_to_review_then_done():
    nodes, edges = _graph_nodes_edges()
    assert "coder" in nodes
    assert "review" in nodes
    assert "done" in nodes
    assert ("coder", "review") in edges
    assert ("review", "done") in edges


def test_review_approved_with_coder_result():
    # A produced implementation is approved; no test gate is consulted.
    class _Q:
        def put_nowait(self, _):
            pass

    out = G.review_node({"_queue": _Q(), "coder_result": "done", "plan": ""})
    assert out["review_result"] == "APPROVED"


def test_review_needs_work_without_coder_result():
    class _Q:
        def put_nowait(self, _):
            pass

    out = G.review_node({"_queue": _Q(), "coder_result": "", "plan": ""})
    assert out["review_result"].startswith("NEEDS WORK")


# ---------------------------------------------------------------------------
# _is_transient_error — 400 is now retryable (some upstream gateways return 400
# for transient conditions that resolve on retry, e.g. minimax-m3:free on
# OpenRouter).
# ---------------------------------------------------------------------------


class _HttpError(Exception):
    """Minimal exception that carries an HTTP status_code, like openai's APIError."""

    def __init__(self, status_code: int, message: str = ""):
        super().__init__(message or f"Error code: {status_code}")
        self.status_code = status_code


def test_is_transient_error_400_is_retryable():
    """HTTP 400 is transient because some upstream gateways return it for
    transient conditions that resolve on retry."""
    exc = _HttpError(400, "Bad Request")
    assert G._is_transient_error(exc) is True


def test_is_transient_error_429_is_retryable():
    exc = _HttpError(429, "Rate limit exceeded")
    assert G._is_transient_error(exc) is True


def test_is_transient_error_500_is_retryable():
    exc = _HttpError(500, "Internal Server Error")
    assert G._is_transient_error(exc) is True


def test_is_transient_error_401_is_not_retryable():
    """401 (auth) is a hard failure — retrying won't help."""
    exc = _HttpError(401, "Unauthorized")
    assert G._is_transient_error(exc) is False


def test_is_transient_error_404_is_not_retryable():
    """404 is a hard failure — retrying won't help."""
    exc = _HttpError(404, "Not Found")
    assert G._is_transient_error(exc) is False


def test_is_transient_error_network_blip_is_retryable():
    """No status code but a network/timeout phrase is retryable."""
    exc = ConnectionError("Connection reset by peer")
    assert G._is_transient_error(exc) is True
