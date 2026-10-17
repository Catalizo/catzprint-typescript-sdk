"""Checks SDK sealed boxes with libsodium (PyNaCl). Reads JSON on stdin:
{"secret_key": hex, "sealed": [{"msg": hex, "sealed": hex}],
 "deterministic": [{"esk": hex, "pk": hex, "msg": hex, "sealed": hex}]}
Prints {"opened": [bool...], "deterministic": [bool...]}."""
import hashlib
import json
import sys

from nacl.public import Box, PrivateKey, PublicKey, SealedBox

req = json.load(sys.stdin)
sk = PrivateKey(bytes.fromhex(req["secret_key"]))
opened = []
for c in req["sealed"]:
    try:
        opened.append(SealedBox(sk).decrypt(bytes.fromhex(c["sealed"])) == bytes.fromhex(c["msg"]))
    except Exception:
        opened.append(False)
det = []
for c in req["deterministic"]:
    esk = PrivateKey(bytes.fromhex(c["esk"]))
    pk = PublicKey(bytes.fromhex(c["pk"]))
    epk = bytes(esk.public_key)
    nonce = hashlib.blake2b(epk + bytes(pk), digest_size=24).digest()
    expected = epk + Box(esk, pk).encrypt(bytes.fromhex(c["msg"]), nonce).ciphertext
    det.append(expected.hex() == c["sealed"])
json.dump({"opened": opened, "deterministic": det}, sys.stdout)
