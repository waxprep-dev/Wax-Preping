import json
import hashlib
from typing import Dict, Any, Optional
from datetime import datetime

from app.security import security


class MessageClassifier:
    STREAM_TEXT = "text"
    STREAM_STATUS = "status"
    STREAM_REACTION = "reaction"
    STREAM_INTERACTIVE = "interactive"
    STREAM_LOCATION = "location"
    STREAM_UNKNOWN = "unknown"
    
    @classmethod
    def classify(cls, payload: Dict[str, Any]) -> str:
        entry = payload.get("entry", [{}])[0]
        changes = entry.get("changes", [{}])[0]
        value = changes.get("value", {})
        
        if "messages" in value:
            msg = value["messages"][0]
            msg_type = msg.get("type", "")
            type_map = {
                "text": cls.STREAM_TEXT,
                "image": cls.STREAM_UNKNOWN,
                "audio": cls.STREAM_UNKNOWN,
                "video": cls.STREAM_UNKNOWN,
                "document": cls.STREAM_UNKNOWN,
                "location": cls.STREAM_LOCATION,
                "contacts": cls.STREAM_UNKNOWN,
                "sticker": cls.STREAM_UNKNOWN,
                "reaction": cls.STREAM_REACTION,
                "interactive": cls.STREAM_INTERACTIVE,
                "button": cls.STREAM_INTERACTIVE,
                "unknown": cls.STREAM_UNKNOWN,
            }
            return type_map.get(msg_type, cls.STREAM_UNKNOWN)
        
        if "statuses" in value:
            return cls.STREAM_STATUS
        
        return cls.STREAM_UNKNOWN


class WebhookNormalizer:
    def normalize(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        entry = payload.get("entry", [{}])[0]
        changes = entry.get("changes", [{}])[0]
        value = changes.get("value", {})
        metadata = value.get("metadata", {})
        phone_number_id = metadata.get("phone_number_id")
        
        if "messages" in value:
            return self._normalize_message(value, phone_number_id)
        if "statuses" in value:
            return self._normalize_status(value, phone_number_id)
        return None
    
    def _normalize_message(self, value: Dict, phone_number_id: str) -> Dict[str, Any]:
        msg = value["messages"][0]
        contact = value.get("contacts", [{}])[0]
        phone = msg.get("from", "")
        wax_id = security.generate_wax_id(phone)
        
        content = json.dumps(msg.get(msg.get("type", "text"), {}), sort_keys=True)
        fingerprint = hashlib.blake2b(
            f"{phone}:{content}:{msg.get('timestamp', '')}".encode(),
            digest_size=16
        ).hexdigest()
        
        return {
            "event_type": "message",
            "wax_id": wax_id,
            "phone_number": phone,
            "phone_number_id": phone_number_id,
            "message_id": msg.get("id"),
            "timestamp": int(msg.get("timestamp", 0)),
            "type": msg.get("type"),
            "body": msg.get("text", {}).get("body") if msg.get("type") == "text" else None,
            "raw_message": msg,
            "contact_name": contact.get("profile", {}).get("name"),
            "fingerprint": fingerprint,
            "received_at": datetime.utcnow().isoformat(),
            "trace_id": hashlib.blake2b(
                f"{msg.get('id')}:{msg.get('timestamp')}".encode(),
                digest_size=16
            ).hexdigest()
        }
    
    def _normalize_status(self, value: Dict, phone_number_id: str) -> Dict[str, Any]:
        status = value["statuses"][0]
        phone = status.get("recipient_id", "")
        return {
            "event_type": "status",
            "wax_id": security.generate_wax_id(phone),
            "phone_number": phone,
            "phone_number_id": phone_number_id,
            "message_id": status.get("id"),
            "status": status.get("status"),
            "timestamp": int(status.get("timestamp", 0)),
            "conversation_id": status.get("conversation", {}).get("id"),
            "error_code": status.get("errors", [{}])[0].get("code") if status.get("errors") else None,
            "received_at": datetime.utcnow().isoformat(),
            "trace_id": hashlib.blake2b(
                f"{status.get('id')}:{status.get('timestamp')}".encode(),
                digest_size=16
            ).hexdigest()
        }


class StateMachine:
    VALID_TRANSITIONS = {
        None: ["sent", "failed"],
        "sent": ["delivered", "failed", "read"],
        "delivered": ["read", "failed"],
        "read": ["failed"],
        "failed": []
    }
    
    def can_transition(self, current: Optional[str], new: str) -> bool:
        allowed = self.VALID_TRANSITIONS.get(current, [])
        return new in allowed
    
    def infer_missing_states(self, current: Optional[str], new: str) -> list:
        inferences = []
        if new == "read" and current in [None, "sent"]:
            inferences.append("delivered")
        return inferences
