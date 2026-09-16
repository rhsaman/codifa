#!/bin/bash
# یک‌بار اجرا کن: ./scripts/create-dev-cert.sh
# یک certificate امضای کد پایدار و محلی می‌سازد تا امضای اپ بین بیلدهای dist:mac ثابت بماند
# و مجوز Accessibility دیگر بین بیلدها پاک نشود.
set -e

CERT_NAME="Coder Dev Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
  echo "✅ certificate «$CERT_NAME» از قبل وجود دارد. کاری لازم نیست."
  exit 0
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/codesign.conf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = $CERT_NAME

[ext]
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 \
  -keyout "$TMP_DIR/codesign.key" \
  -out "$TMP_DIR/codesign.crt" \
  -days 3650 -nodes \
  -config "$TMP_DIR/codesign.conf"

if openssl pkcs12 -export -help 2>&1 | grep -q -- '-legacy'; then
  LEGACY_FLAG="-legacy"
else
  LEGACY_FLAG=""
fi

openssl pkcs12 -export $LEGACY_FLAG \
  -out "$TMP_DIR/codesign.p12" \
  -inkey "$TMP_DIR/codesign.key" \
  -in "$TMP_DIR/codesign.crt" \
  -passout pass:temp1234

security import "$TMP_DIR/codesign.p12" -k "$KEYCHAIN" -P temp1234 -T /usr/bin/codesign -A

security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" 2>/dev/null || true

echo "✅ certificate «$CERT_NAME» ساخته و در کیچین import شد."
security find-identity -v -p codesigning | grep "$CERT_NAME" || true
echo ""
echo "حالا می‌توانی 'npm run dist:mac' را اجرا کنی — امضا از این پس ثابت می‌ماند."
