class JobCancelled(Exception):
    """Raised by a progress callback when a job is cancelled between stages."""
