"""Session owner identity; legacy aliases are for existing cards only."""

import re


def owner_from_session(session_id: str) -> str:
    """Keep the full session ID: time-ordered UUIDs share short prefixes."""
    return f"ac:{session_id}"


def session_owners(session_id: str) -> tuple[str, str]:
    """Exact identity plus the old eight-character alias for compatibility reads."""
    return owner_from_session(session_id), owner_from_session(session_id[:8])


def is_legacy_owner(owner: str) -> bool:
    return re.fullmatch(r"ac:[0-9a-fA-F]{8}", owner) is not None
