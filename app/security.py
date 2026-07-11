import hmac
import hashlib
import ipaddress
from typing import Optional
from functools import lru_cache

from cryptography.fernet import Fernet

from app.config import get_settings


class SecurityManager:
    def __init__(self):
        settings = get_settings()
        self.fernet = Fernet(settings.ENCRYPTION_KEY.encode())
        self._settings = settings

    def verify_signature(self, raw_body: bytes, signature_header: Optional[str]) -> bool:
        if not signature_header:
            return False
        expected = hmac.new(
            self._settings.WHATSAPP_APP_SECRET.encode(),
            raw_body,
            hashlib.sha256
        ).hexdigest()
        received = signature_header.replace("sha256=", "")
        return hmac.compare_digest(expected, received)

    def is_ip_allowed(self, client_ip: str) -> bool:
        if not self._settings.ALLOWED_IP_RANGES:
            return True
        try:
            client = ipaddress.ip_address(client_ip)
            for cidr in self._settings.ALLOWED_IP_RANGES:
                if client in ipaddress.ip_network(cidr, strict=False):
                    return True
            return False
        except ValueError:
            return False

    def seal_payload(self, payload: str) -> str:
        return self.fernet.encrypt(payload.encode()).decode()

    def unseal_payload(self, sealed: str) -> str:
        return self.fernet.decrypt(sealed.encode()).decode()

    def generate_wax_id(self, phone_number: str) -> str:
        raw = f"{phone_number}:{self._settings.WHATSAPP_APP_SECRET}:wax_v1"
        hash_bytes = hashlib.blake2b(raw.encode(), digest_size=16).hexdigest()
        return f"wx_{hash_bytes}"


@lru_cache()
def get_security_manager() -> SecurityManager:
    """Lazy singleton so SecurityManager is only created when first used."""
    return SecurityManager()


# Backward-compatible alias
security = get_security_manager()
