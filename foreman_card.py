"""Compatibility import for the packaged foreman_card implementation."""
import sys
from nawaban import foreman_card as _implementation

sys.modules[__name__] = _implementation
