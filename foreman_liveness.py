"""Compatibility import for the packaged foreman_liveness implementation."""
import sys
from nawaban import foreman_liveness as _implementation

sys.modules[__name__] = _implementation
