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

# ============================================================
# Practical Sample Functions (server→browser delegation demos)
# ============================================================

# Test 11: formValidate - valid email
echo "📝 Test 11: POST /unzen/exec/formValidate (valid email)"
RESULT=$(echo '{"args":[{"email":"user@example.com"}]}' | curl -s -X POST ${BASE_URL}/unzen/exec/formValidate -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"valid":true'* ]]; then
  echo "✅ formValidate OK (valid email accepted)"
else
  echo "❌ formValidate FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 12: formValidate - invalid email
echo "📝 Test 12: POST /unzen/exec/formValidate (invalid email)"
RESULT=$(echo '{"args":[{"email":"bad-email"}]}' | curl -s -X POST ${BASE_URL}/unzen/exec/formValidate -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"valid":false'* ]] && [[ $RESULT == *'"email"'* ]]; then
  echo "✅ formValidate OK (invalid email rejected)"
else
  echo "❌ formValidate FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 13: calculatePrice - basic order
echo "💰 Test 13: POST /unzen/exec/calculatePrice (JP order)"
RESULT=$(echo '{"args":[{"items":[{"name":"Widget","price":100,"quantity":1}],"region":"JP"}]}' | curl -s -X POST ${BASE_URL}/unzen/exec/calculatePrice -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"subtotal":100'* ]] && [[ $RESULT == *'"tax":10'* ]]; then
  echo "✅ calculatePrice OK (JP tax 10% applied)"
else
  echo "❌ calculatePrice FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 14: calculatePrice - with discount
echo "💰 Test 14: POST /unzen/exec/calculatePrice (with discount)"
RESULT=$(echo '{"args":[{"items":[{"name":"Item","price":200,"quantity":1}],"region":"JP","discount":{"type":"percentage","value":10}}]}' | curl -s -X POST ${BASE_URL}/unzen/exec/calculatePrice -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"discount":20'* ]]; then
  echo "✅ calculatePrice OK (10% discount applied)"
else
  echo "❌ calculatePrice FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 15: markdownToHtml - heading
echo "📄 Test 15: POST /unzen/exec/markdownToHtml (heading)"
RESULT=$(echo '{"args":["# Hello World"]}' | curl -s -X POST ${BASE_URL}/unzen/exec/markdownToHtml -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'<h1>Hello World</h1>'* ]]; then
  echo "✅ markdownToHtml OK (# → h1)"
else
  echo "❌ markdownToHtml FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 16: markdownToHtml - bold and italic
echo "📄 Test 16: POST /unzen/exec/markdownToHtml (inline formatting)"
RESULT=$(echo '{"args":["**bold** and *italic*"]}' | curl -s -X POST ${BASE_URL}/unzen/exec/markdownToHtml -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'<strong>bold</strong>'* ]] && [[ $RESULT == *'<em>italic</em>'* ]]; then
  echo "✅ markdownToHtml OK (bold + italic)"
else
  echo "❌ markdownToHtml FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 17: textStats - word count
echo "📊 Test 17: POST /unzen/exec/textStats (word count)"
RESULT=$(echo '{"args":["The quick brown fox"]}' | curl -s -X POST ${BASE_URL}/unzen/exec/textStats -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"words":4'* ]]; then
  echo "✅ textStats OK (4 words counted)"
else
  echo "❌ textStats FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

# Test 18: textStats - sentence and paragraph count
echo "📊 Test 18: POST /unzen/exec/textStats (sentences + readability)"
RESULT=$(echo '{"args":["Hello world. How are you?"]}' | curl -s -X POST ${BASE_URL}/unzen/exec/textStats -H 'Content-Type: application/json' -d @-)
if [[ $RESULT == *'"sentences":2'* ]] && [[ $RESULT == *'"fleschKincaidGrade"'* ]]; then
  echo "✅ textStats OK (2 sentences, FK grade computed)"
else
  echo "❌ textStats FAILED"
  echo "Response: $RESULT"
  exit 1
fi
echo ""

echo "===================================="
echo "✅ All 18 E2E tests passed!"
echo ""
echo "🎉 Demo server is working correctly!"
echo "   Visit: ${BASE_URL}"
