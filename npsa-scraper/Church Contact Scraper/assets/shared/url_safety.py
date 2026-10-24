"""
Keep the crawler on the public internet.

Website URLs come from Google Places listings and from links on the pages we
crawl, so they are not ours to trust. Before fetching one we resolve its host
and refuse anything that is not a public address (loopback, private ranges,
link-local, carrier-grade NAT, IPv6 unique-local / link-local, and IPv4 hidden
inside IPv6), plus hostnames ending in .internal or localhost. Redirects are
followed by hand so every hop gets the same check.
"""

import ipaddress
import socket
from typing import Optional
from urllib.parse import urljoin, urlsplit

import requests

MAX_REDIRECTS = 5
UNRESOLVED = "host does not resolve"

_BLOCKED_NETWORKS = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::/128",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
]


class BlockedURLError(Exception):
    """Raised when a URL (or a redirect hop) points somewhere we won't fetch."""

    def __init__(self, url: str, reason: str):
        super().__init__(f"{reason}: {url}")
        self.url = url
        self.reason = reason


def _is_public_ip(ip) -> bool:
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return _is_public_ip(ip.ipv4_mapped)
        if ip.sixtofour is not None and not _is_public_ip(ip.sixtofour):
            return False
    if any(ip in net for net in _BLOCKED_NETWORKS if net.version == ip.version):
        return False
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def blocked_reason(url: str) -> Optional[str]:
    """Return why url must not be fetched, or None if it is a public http(s) URL."""
    try:
        parts = urlsplit(str(url).strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        return "malformed URL"
    if parts.scheme not in ("http", "https"):
        return "not http(s)"
    if not host:
        return "no host"
    host = host.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".internal"):
        return "internal hostname"
    try:
        infos = socket.getaddrinfo(
            host, port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP
        )
    except (socket.gaierror, UnicodeError, OSError):
        return UNRESOLVED
    if not infos:
        return UNRESOLVED
    for info in infos:
        addr = info[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return "unparseable address"
        if not _is_public_ip(ip):
            return "non-public address"
    return None


def get_public(url: str, *, max_redirects: int = MAX_REDIRECTS, **kwargs) -> requests.Response:
    """requests.get that refuses non-public hosts, checking every redirect hop.

    Raises BlockedURLError for a refused URL or hop,
    requests.exceptions.ConnectionError when a host does not resolve (so
    callers' normal retry handling applies), and
    requests.exceptions.TooManyRedirects past max_redirects.
    """
    kwargs["allow_redirects"] = False
    current = url
    for _ in range(max_redirects + 1):
        reason = blocked_reason(current)
        if reason == UNRESOLVED:
            raise requests.exceptions.ConnectionError(f"{reason}: {current}")
        if reason:
            raise BlockedURLError(current, reason)
        response = requests.get(current, **kwargs)
        if not response.is_redirect:
            return response
        current = urljoin(response.url, response.headers["location"])
        response.close()
    raise requests.exceptions.TooManyRedirects(f"More than {max_redirects} redirects: {url}")
