"""Deterministic quant core (Step 2.3, QN-040…048).

Everything in this package is deterministic given its inputs: fixed seeds,
causal (trailing-window) computations, and point-in-time joins only. No LLM
ever touches anything in here (system design §10).
"""
