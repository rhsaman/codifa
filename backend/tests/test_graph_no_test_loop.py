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
