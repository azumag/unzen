#!/bin/bash
# E2E Integration Test Script

set -e

echo "🧪 QJS-proto E2E Integration Tests"
echo "===================================="
echo ""

BASE_URL="http://localhost:3000"

# Test 1: Manifest endpoint
echo "📋 Test 1: GET /unzen/manifest"
MANIFEST=$(curl -s ${BASE_URL}/unzen/manifest)
echo "$MANIFEST" | python3 -m json.tool > /dev/null
echo "✅ Manifest endpoint OK"
echo ""

# Test 2: Code endpoint
echo "📦 Test 2: GET /unzen/code/spamCheck"
CODE=$(curl -s ${BASE_URL}/unzen/code/spamCheck)
if [[ $CODE == *"function run"* ]]; then
  echo "✅ Code endpoint OK (contains 'function run')"
else
  echo "❌ Code endpoint FAILED (missing 'function run')"
  exit 1
fi
echo ""

# Test 3: Execution endpoint - spam detection (positive)
echo "🔍 Test 3: POST /unzen/exec/spamCheck (spam text)"
RESULT=$(echo '{"args":["spam message"]}' | curl -s -X POST ${BASE_URL}/unzen/exec/spamCheck -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"result":true'* ]]; then
  echo "✅ Spam detection OK (detected spam)"
else
  echo "❌ Spam detection FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 4: Execution endpoint - spam detection (negative)
echo "🔍 Test 4: POST /unzen/exec/spamCheck (clean text)"
RESULT=$(echo '{"args":["Hello world"]}' | curl -s -X POST ${BASE_URL}/unzen/exec/spamCheck -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"result":false'* ]]; then
  echo "✅ Spam detection OK (clean text)"
else
  echo "❌ Spam detection FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 5: Math function
echo "➗ Test 5: POST /unzen/exec/multiply"
RESULT=$(echo '{"args":[5, 7]}' | curl -s -X POST ${BASE_URL}/unzen/exec/multiply -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"result":35'* ]]; then
  echo "✅ Multiply function OK (5 × 7 = 35)"
else
  echo "❌ Multiply function FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 6: Array function
echo "📊 Test 6: POST /unzen/exec/doubleArray"
RESULT=$(echo '{"args":[[1,2,3]]}' | curl -s -X POST ${BASE_URL}/unzen/exec/doubleArray -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"result":[2,4,6]'* ]]; then
  echo "✅ Array function OK ([1,2,3] → [2,4,6])"
else
  echo "❌ Array function FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 7: Object function
echo "👤 Test 7: POST /unzen/exec/getUserInfo"
RESULT=$(echo '{"args":[{"firstName":"John","lastName":"Doe","age":25}]}' | curl -s -X POST ${BASE_URL}/unzen/exec/getUserInfo -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"fullName":"John Doe"'* ]] && [[ $RESULT == *'"isAdult":true'* ]]; then
  echo "✅ Object function OK (user info transformed)"
else
  echo "❌ Object function FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 8: Error handling (non-existent function)
echo "❌ Test 8: POST /unzen/exec/nonExistent (error handling)"
RESULT=$(curl -s -X POST ${BASE_URL}/unzen/exec/nonExistent -H 'Content-Type: application/json' -d '{"args":[]}')
if [[ $RESULT == *'"error"'* ]]; then
  echo "✅ Error handling OK (404 for non-existent function)"
else
  echo "❌ Error handling FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 9: Client bundle endpoint
echo "📦 Test 9: GET /client.js"
CLIENT_CODE=$(curl -s ${BASE_URL}/client.js)
if [[ $CLIENT_CODE == *"UnzenClient"* ]]; then
  echo "✅ Client bundle OK (contains 'UnzenClient')"
else
  echo "❌ Client bundle FAILED"
  exit 1
fi
echo ""

# Test 10: Static file serving
echo "🌐 Test 10: GET / (demo page)"
INDEX_HTML=$(curl -s ${BASE_URL}/)
if [[ $INDEX_HTML == *"QJS-proto E2E Demo"* ]]; then
  echo "✅ Static file serving OK (demo page loads)"
else
  echo "❌ Static file serving FAILED"
  exit 1
fi
echo ""

echo "===================================="
echo "✅ All 10 E2E tests passed!"
echo ""
echo "🎉 Demo server is working correctly!"
echo "   Visit: ${BASE_URL}"
